import express from 'express';

const MCP_HOST = 'mcp.epistery.io';

/**
 * McpProxy — thin proxy from epistery-scan to mcp-registry via harness.
 *
 * Each route fans out to the mcp-registry child process and extracts its
 * response. Returns 503 when the harness is unavailable (dev mode).
 */
export default class McpProxy {
  constructor(connector, harness) {
    this.connector = connector;
    this.harness = harness || null;
  }

  routes() {
    const router = express.Router();

    router.get('/categories', (req, res) => this._proxy(req, res, '/api/categories'));
    router.get('/services',   (req, res) => this._proxy(req, res, this._withQuery('/api/services', req.query)));
    router.get('/search',     (req, res) => this._proxy(req, res, this._withQuery('/api/search', req.query)));
    router.get('/service/:name', (req, res) => this._proxy(req, res, `/api/service/${encodeURIComponent(req.params.name)}`));
    router.get('/stats',      (req, res) => this._proxy(req, res, '/api/stats'));

    return router;
  }

  async _proxy(req, res, path) {
    if (!this.harness) {
      return res.status(503).json({ error: 'MCP Registry unavailable — no harness configured' });
    }

    try {
      const results = await this.harness.query(path, 5000);
      const hit = results.find(r => r.hostname === MCP_HOST);
      if (!hit) {
        return res.status(503).json({ error: 'MCP Registry unavailable' });
      }
      res.json(hit.data);
    } catch (err) {
      console.error('[mcp-proxy]', err.message);
      res.status(503).json({ error: 'MCP Registry unavailable' });
    }
  }

  _withQuery(base, query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') params.set(k, v);
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }
}
