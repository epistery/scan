/**
 * Harness — lightweight child process manager for epistery-scan.
 *
 * Spawns child servers (e.g. mcp-registry) as UPSTREAM processes, routes
 * hostname-based traffic to them, health-checks them, and shuts them down
 * gracefully on exit.
 *
 * Config: { "mcp.epistery.io": "/home/.../mcp-registry", ... }
 *   key = hostname to match
 *   value = cwd of the child process (must contain src/server.js)
 */
import { spawn } from 'child_process';
import http from 'http';

const BASE_PORT = 53900;

export default class Harness {
  constructor(config) {
    this.config = config;  // { hostname: cwd, ... }
    this.children = {};    // { hostname: { proc, port, healthy } }
    this._healthTimer = null;
  }

  async start() {
    const hostnames = Object.keys(this.config);
    if (!hostnames.length) return;

    let portOffset = 0;
    for (const hostname of hostnames) {
      const cwd = this.config[hostname];
      const port = BASE_PORT + portOffset++;
      await this._spawn(hostname, cwd, port);
    }

    // Health check every 30s
    this._healthTimer = setInterval(() => this._checkAll(), 30000);
  }

  async _spawn(hostname, cwd, port) {
    const proc = spawn('node', ['src/server.js'], {
      cwd,
      env: { ...process.env, UPSTREAM: '1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.children[hostname] = { proc, port, healthy: false };

    proc.stdout.on('data', (buf) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        console.log(`[harness:${hostname}] ${line}`);
      }
    });
    proc.stderr.on('data', (buf) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        console.error(`[harness:${hostname}] ${line}`);
      }
    });
    proc.on('exit', (code, signal) => {
      console.warn(`[harness:${hostname}] exited code=${code} signal=${signal}`);
      const child = this.children[hostname];
      if (child) child.healthy = false;
    });

    // Wait for /health to respond (up to 15s)
    const ok = await this._waitHealthy(hostname, port, 15000);
    if (ok) {
      this.children[hostname].healthy = true;
      console.log(`[harness] ${hostname} ready on port ${port} (pid ${proc.pid})`);
    } else {
      console.error(`[harness] ${hostname} failed health check after 15s`);
    }
  }

  _waitHealthy(hostname, port, timeout) {
    const start = Date.now();
    return new Promise((resolve) => {
      const attempt = () => {
        if (Date.now() - start > timeout) return resolve(false);
        this._ping(port).then(ok => {
          if (ok) return resolve(true);
          setTimeout(attempt, 500);
        });
      };
      attempt();
    });
  }

  _ping(port) {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data.status === 'ok');
          } catch {
            resolve(false);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  _checkAll() {
    for (const [hostname, child] of Object.entries(this.children)) {
      this._ping(child.port).then(ok => {
        if (!ok && child.healthy) {
          console.error(`[harness] ${hostname} health check failed`);
        }
        child.healthy = ok;
      });
    }
  }

  /**
   * Fan-out GET to all healthy children in parallel.
   * Returns [{ hostname, data }], filtering out failures.
   */
  async query(urlPath, timeout = 2500) {
    const entries = Object.entries(this.children).filter(([, c]) => c.healthy);
    if (!entries.length) return [];

    const results = await Promise.all(
      entries.map(([hostname, child]) =>
        this._get(child.port, urlPath, hostname, timeout)
      )
    );
    return results.filter(Boolean);
  }

  /**
   * Single-child GET. Resolves { hostname, data } or null on error/timeout.
   */
  _get(port, urlPath, hostname, timeout) {
    return new Promise((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${port}${urlPath}`,
        { timeout, headers: { host: hostname, accept: 'application/json' } },
        (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            try {
              resolve({ hostname, data: JSON.parse(body) });
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  middleware() {
    return (req, res, next) => {
      const child = this.children[req.hostname];
      if (!child || !child.healthy) return next();

      const opts = {
        hostname: '127.0.0.1',
        port: child.port,
        path: req.originalUrl,
        method: req.method,
        headers: { ...req.headers, host: req.hostname }
      };

      const proxy = http.request(opts, (upstream) => {
        res.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(res);
      });

      proxy.on('error', (err) => {
        console.error(`[harness] proxy error for ${req.hostname}: ${err.message}`);
        if (!res.headersSent) res.status(502).json({ error: 'child unavailable' });
      });

      req.pipe(proxy);
    };
  }

  async shutdown() {
    if (this._healthTimer) clearInterval(this._healthTimer);

    const entries = Object.entries(this.children);
    if (!entries.length) return;

    // Send SIGTERM to all children
    for (const [hostname, child] of entries) {
      if (child.proc.exitCode === null) {
        console.log(`[harness] sending SIGTERM to ${hostname} (pid ${child.proc.pid})`);
        child.proc.kill('SIGTERM');
      }
    }

    // Wait up to 5s for graceful exit, then SIGKILL
    await Promise.all(entries.map(([hostname, child]) => {
      if (child.proc.exitCode !== null) return;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.warn(`[harness] SIGKILL ${hostname} (pid ${child.proc.pid})`);
          child.proc.kill('SIGKILL');
          resolve();
        }, 5000);
        child.proc.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    }));
  }
}
