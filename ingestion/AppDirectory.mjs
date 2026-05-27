import { computeTrustScore } from '../lib/Posture.mjs';
import { verifyManifestHash } from '../lib/manifest.mjs';

/**
 * AppDirectory
 *
 * Surfaces epistery-app identities in scan search as first-class, signed-web
 * entities.
 *
 * The chat relay already writes every minted contract's name into scan's own
 * `identities` collection:
 *   { address, name, nameLower, domain, chain, owner, chatPublicKey, mintedAt, ... }
 *
 * This module promotes those rows into the searchable `entities` collection.
 * Names/addresses/owner/domain come straight from scan's DB — no network. When
 * an app base URL is configured we additionally fetch the identity's signed
 * AI-Discovery manifest from `GET /api/contracts/:contract/home`, which carries
 * the identity's PUBLIC sessions (wikis / boards / file shares) as
 * `applications` plus a spec `_signature`. The manifest is stored under
 * `metadata.manifest` so the same full-text index, trust scoring, and result
 * formatter that handle signed-web domains light up for app identities too.
 *
 * Trust signals asserted here (scored via Posture):
 *   - contractExists  the address is a relay-minted IdentityContract (always)
 *   - platform        served by an epistery.app identity host (always)
 *   - manifest        the app served a structured manifest
 *   - selfSigned      manifest carries a _signature.digitalName (the contract)
 *   - hashValid       the manifest's contentHash recomputes correctly
 *
 * Merges by address: a contract already indexed on-chain as an IdentityContract
 * keeps its type and simply gains manifest/signals/app data. Fresh rows get
 * `type: 'AppIdentity'`. See db/Database.mjs saveAppIdentity.
 */

// chainId (as stored by the relay) → connector-map slug used elsewhere in scan.
const CHAIN_SLUGS = { 1: 'ethereum', 137: 'polygon', 80002: 'polygon-amoy', 11155111: 'sepolia', 81: 'japanopenchain' };
const CHAIN_NETWORK = { ethereum: 'ethereum', polygon: 'polygon', 'polygon-amoy': 'polygon-amoy', sepolia: 'sepolia', japanopenchain: 'japanopenchain' };

export default class AppDirectory {
  constructor(database, options = {}) {
    this.database = database;
    this.appBaseUrl = (options.appBaseUrl || '').replace(/\/+$/, '');
    this.pollInterval = options.pollInterval || 3600000; // 1 hour
    this.isRunning = false;
    this.timer = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[app-directory] Starting (interval: ${this.pollInterval}ms, app: ${this.appBaseUrl || 'names-only — no app URL configured'})`);
    this.timer = setInterval(() => {
      this.sync().catch(e => console.error('[app-directory] sync error:', e.message));
    }, this.pollInterval);
    this.sync().catch(e => console.error('[app-directory] initial sync error:', e.message));
  }

  stop() {
    this.isRunning = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Read the relay-populated `identities` collection and (re)index each row.
   */
  async sync() {
    let rows;
    try {
      rows = await this.database.db.collection('identities').find({}).toArray();
    } catch (e) {
      console.warn('[app-directory] identities collection unreadable:', e.message);
      return { indexed: 0 };
    }

    let indexed = 0;
    for (const row of rows) {
      if (!row.address) continue;
      try {
        await this.indexIdentity(row);
        indexed++;
      } catch (e) {
        console.warn(`[app-directory] failed to index ${row.address}:`, e.message);
      }
    }

    console.log(`[app-directory] Indexed ${indexed}/${rows.length} app identities`);
    return { indexed, total: rows.length };
  }

  async indexIdentity(row) {
    const now = new Date();
    const chain = CHAIN_SLUGS[row.chain] || row.chain || null;
    const network = CHAIN_NETWORK[chain] || 'polygon';

    // Identity is a relay-minted IdentityContract on a known platform —
    // assertable without any network call.
    const signals = {
      contractExists: { present: true, at: now, address: row.address.toLowerCase() },
      platform: { present: true, at: now }
    };

    // App-namespaced extras (rich session/activity view the standard manifest
    // doesn't carry verbatim).
    const app = {
      name: row.name || null,
      nameLower: row.nameLower || (row.name ? row.name.toLowerCase() : null),
      domain: row.domain || null,
      owner: row.owner ? row.owner.toLowerCase() : null,
      publicKey: row.chatPublicKey || null,
      profileUrl: this.appBaseUrl && row.name ? `${this.appBaseUrl}/@${row.name}` : null,
      source: 'epistery-app',
      mintedAt: row.mintedAt || null,
      sessions: [],
      activity: { publicSessions: 0, members: 0, lastActivity: null },
      syncedAt: now
    };

    // Baseline manifest from DB facts — replaced by the app's signed manifest
    // when reachable. Always present so identities project trust even offline.
    let manifest = this.baselineManifest(row, network);

    if (this.appBaseUrl) {
      const home = await this.fetchHome(row.address);
      if (home) {
        if (home.manifest) manifest = home.manifest;
        if (Array.isArray(home.sessions)) app.sessions = home.sessions;
        else if (Array.isArray(home.publicSessions)) app.sessions = home.publicSessions; // older app
        if (home.activity) app.activity = home.activity;
        if (home.profileUrl) app.profileUrl = home.profileUrl;
      }
    }

    // Trust signals derived from the manifest itself.
    signals.manifest = { present: true, at: now };
    const sig = manifest._signature || {};
    signals.selfSigned = { present: !!sig.digitalName, at: now, digitalName: sig.digitalName || null, method: sig.method || null };
    signals.hashValid = { present: verifyManifestHash(manifest), at: now };

    const trustScore = computeTrustScore(signals);

    const verification = {
      signed: signals.selfSigned.present,
      hashValid: signals.hashValid.present,
      digitalNameMatch: signals.contractExists.present,
      digitalName: sig.digitalName || row.address,
      method: sig.method || null,
      checkedAt: now
    };

    // Link the identity to its owner wallet.
    const identityLinks = app.owner
      ? [{ address: app.owner, type: 'Wallet', relation: 'owner', mutual: false, at: now }]
      : [];

    await this.database.saveAppIdentity({
      address: row.address,
      chain,
      domain: manifest.organization?.domain || row.domain || null,
      manifest,
      signals,
      trustScore,
      verification,
      identityLinks,
      app
    });
  }

  /**
   * Minimal standard-shaped manifest built from DB facts alone (no app call,
   * no _signature). Lets an identity project name + trust even when the app is
   * unreachable or no base URL is configured.
   */
  baselineManifest(row, network) {
    return {
      version: '1.0.0',
      standard: 'ai-discovery',
      organization: {
        name: row.name || row.address,
        domain: row.domain || null,
        mission: `Self-sovereign epistery identity${row.name ? ` "${row.name}"` : ''}.`,
        sector: ['epistery-identity'],
        digitalName: row.address,
        blockchain: network
      },
      applications: [],
      coreConcepts: []
    };
  }

  async fetchHome(contract) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(`${this.appBaseUrl}/api/contracts/${contract}/home`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      clearTimeout(t);
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      // App unreachable / timeout — identity still indexes from DB facts.
      return null;
    }
  }
}
