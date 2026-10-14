import express from 'express';
import { receiptFacts, resolveAndVerify, VERIFIER } from '../lib/Receipts.mjs';

/**
 * Rootz Receipts, verified here with the public Rootz verifier (lib/Receipts.mjs). Facts, not verdicts.
 *   POST /api/receipts/verify   { receipt, answer_b64?, request_b64? }
 *   GET  /api/receipts/resolve?resolver=<https://…/.well-known/origin-receipts/>&hash=sha256:<b64url>
 *   GET  /api/receipts/verifier the build Scan runs
 */
export default class ReceiptsHandler {
  routes() {
    const router = express.Router();
    router.get('/verifier', (req, res) => res.json(VERIFIER));
    router.post('/verify', async (req, res) => {
      try {
        const { receipt, answer_b64, request_b64 } = req.body ?? {};
        if (!receipt || typeof receipt !== 'object') return res.status(400).json({ error: 'receipt is required' });
        const b = (s) => (typeof s === 'string' ? Buffer.from(s, 'base64') : undefined);
        res.json(await receiptFacts(receipt, { answer: b(answer_b64), request: b(request_b64) }));
      } catch (e) { res.status(422).json({ error: e.message }); }
    });
    router.get('/resolve', async (req, res) => {
      try { res.json(await resolveAndVerify(String(req.query.resolver ?? 'https://receipts.rootz.global/.well-known/origin-receipts/'), String(req.query.hash ?? ''))); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
    return router;
  }
}
