/**
 * TLS probe — the certificate the domain presents on 443, read now.
 *
 * Whether it validates for the name, who issued it, the organization it names
 * (if any), and its validity window. Facts of the handshake; no verdict.
 */
import tls from 'tls';

export function probeTls(host, { timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    const at = new Date();
    const done = (facts) => { socket.destroy(); resolve({ at, ...facts }); };
    const socket = tls.connect({ host, port: 443, servername: host, timeout, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.subject) return done({ present: false });
      done({
        present: true,
        valid: socket.authorized,
        error: socket.authorized ? null : String(socket.authorizationError || ''),
        subject: cert.subject.CN || null,
        organization: cert.subject.O || null,
        issuer: cert.issuer?.O || cert.issuer?.CN || null,
        validFrom: cert.valid_from ? new Date(cert.valid_from) : null,
        validTo: cert.valid_to ? new Date(cert.valid_to) : null
      });
    });
    socket.on('timeout', () => done({ present: false, error: 'timeout' }));
    socket.on('error', (err) => done({ present: false, error: err.code || err.message }));
  });
}
