import express from 'express';
import { originFacts, stampOriginClaims } from '../lib/Present.mjs';
import { signResponse } from '../lib/sign.mjs';

/**
 * Standing — the settlement-time read.
 *
 * GET /api/standing/:domain answers the one question Adnet settlement and the
 * Exchange (and any competing matcher — nothing here is exclusive) ask of
 * scan: what is verifiably true about this publisher domain? The response is
 * the same origin-facts block present.ai carries — rung, signals, signature
 * standing, age, history depth — so the standing read and search results can
 * never disagree. Facts, no verdict: the caller's rule (open /
 * confirmedDomain / whitelisted) turns these facts into a payment decision,
 * and anyone can recompute the same judgment.
 *
 * Unknown domains trigger a background /.well-known/ai crawl and report
 * rung 'open' — not shut out, simply nothing proven yet.
 *
 * Responses are hash-signed by scan's own key when available, so a settlement
 * evidence bundle can carry the standing it was judged against.
 */
export default class StandingHandler {
  constructor(connector) {
    this.connector = connector;
    this.db = connector.db;
    this.ingestion = null;
  }

  setIngestion(ingestion) {
    this.ingestion = ingestion;
  }

  routes() {
    const router = express.Router();

    router.get('/', (req, res) => {
      res.json({
        service: 'epistery-scan standing',
        usage: 'GET /api/standing/{domain}',
        description: 'Verifiable origin facts for a publisher domain — rung, signals, signature standing, age. Facts, no verdict.',
        rungs: ['chain-bound', 'dns', 'claimed', 'open']
      });
    });

    router.get('/:domain', async (req, res) => {
      try {
        const domain = String(req.params.domain || '').trim().toLowerCase();
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
          return res.status(400).json({ error: 'Invalid domain' });
        }

        const standing = await this.standing(domain);

        // Sign for provenance — the evidence bundle can carry this verbatim.
        // One signing shape for every scan surface (lib/sign.mjs).
        res.json(await signResponse(standing, req.app.locals.epistery?.signer));
      } catch (error) {
        console.error('[standing] Error:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    return router;
  }

  async standing(domain) {
    const entity = await this.db.collection('entities').findOne({
      address: domain,
      type: 'AIDiscovery'
    });

    if (!entity) {
      // Not indexed — kick off discovery so the next read has an answer.
      const discovering = !!this.ingestion?.domainDiscovery;
      if (discovering) {
        this.ingestion.domainDiscovery.checkDomain(domain).catch(err =>
          console.warn(`[standing] Discovery trigger failed for ${domain}:`, err.message)
        );
      }
      return {
        domain,
        indexed: false,
        discovering,
        origin: {
          address: null,
          rung: 'open',
          since: null,
          signature: { signed: false, verified: false, method: null },
          signals: {}
        },
        locator: { fetch: `https://${domain}/.well-known/ai`, kind: 'manifest', yields: 'organization' },
        note: discovering
          ? 'Domain not yet indexed — discovery triggered, retry shortly.'
          : 'Domain not indexed.'
      };
    }

    // History depth — stamped by the one owner (stampOriginClaims in
    // lib/Present.mjs), so standing and search can never disagree on the
    // count for the same origin. Omitted on failure, never a faked zero.
    await stampOriginClaims(this.db, [entity]);
    const origin = originFacts(entity);

    return {
      domain,
      indexed: true,
      origin,
      identityLinks: entity.metadata?.identityLinks || [],
      observed: entity._modified || entity._created || null,
      locator: { fetch: `https://${domain}/.well-known/ai`, kind: 'manifest', yields: 'organization' }
    };
  }
}
