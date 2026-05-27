/**
 * AppDirectory
 *
 * Surfaces epistery-app identities in scan search.
 *
 * The chat relay already writes every minted contract's name into scan's own
 * `identities` collection:
 *   { address, name, nameLower, domain, chain, owner, chatPublicKey, mintedAt, ... }
 *
 * This module promotes those rows into the searchable `entities` collection
 * (under `metadata.app`) and, when an app base URL is configured, enriches
 * each with the contract's PUBLIC sessions (message-board / wiki / files)
 * fetched from the app's open `GET /api/contracts/:contract/home` endpoint.
 *
 * Names/addresses/owner/domain are read straight from scan's DB — no network.
 * The public-session enrichment is the only part that reaches the app, and it
 * degrades gracefully: if `appBaseUrl` is unset or the app is unreachable, the
 * identity still indexes with everything but its sessions.
 *
 * We merge into `entities` rather than replace because the on-chain
 * IdentityContractInterpreter may already hold the same contract address
 * (entities.address is uniquely indexed). App data lives under `metadata.app`;
 * `type: 'AppIdentity'` is only stamped on insert, so a monitored
 * IdentityContract keeps its own type and gains an `app` block.
 */

// chainId (as stored by the relay) → connector-map slug used elsewhere in scan.
const CHAIN_SLUGS = { 1: 'ethereum', 137: 'polygon', 80002: 'polygon-amoy', 11155111: 'sepolia', 81: 'japanopenchain' };

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
    // Initial run
    this.sync().catch(e => console.error('[app-directory] initial sync error:', e.message));
  }

  stop() {
    this.isRunning = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Read the relay-populated `identities` collection and (re)index each into
   * `entities`, optionally enriched with the contract's public sessions.
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
        const app = {
          name: row.name || null,
          nameLower: row.nameLower || (row.name ? row.name.toLowerCase() : null),
          domain: row.domain || null,
          owner: row.owner ? row.owner.toLowerCase() : null,
          publicKey: row.chatPublicKey || null,
          profileUrl: this._profileUrl(row),
          source: 'epistery-app',
          mintedAt: row.mintedAt || null,
          syncedAt: new Date()
        };

        if (this.appBaseUrl) {
          const home = await this._fetchHome(row.address);
          if (home) {
            app.sessions = (home.publicSessions || []).map(s => ({
              id: s.id,
              kind: s.kind,
              name: s.name || null,
              description: s.description || null,
              memberCount: s.memberCount ?? null,
              lastActivity: s.lastActivity ?? null
            }));
            app.description = this._describe(app.sessions);
            app.sessionsSyncedAt = new Date();
          }
        }

        await this.database.saveAppIdentity({
          address: row.address,
          chain: CHAIN_SLUGS[row.chain] || row.chain || null,
          app
        });
        indexed++;
      } catch (e) {
        console.warn(`[app-directory] failed to index ${row.address}:`, e.message);
      }
    }

    console.log(`[app-directory] Indexed ${indexed}/${rows.length} app identities`);
    return { indexed, total: rows.length };
  }

  _profileUrl(row) {
    if (!this.appBaseUrl || !row.name) return null;
    return `${this.appBaseUrl}/@${row.name}`;
  }

  /**
   * No identity-level description field exists yet, so synthesize a short,
   * human-readable summary from the public-session mix. Falls back to null
   * when an identity exposes nothing public.
   */
  _describe(sessions) {
    if (!sessions || !sessions.length) return null;
    const byKind = {};
    for (const s of sessions) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    return Object.entries(byKind)
      .map(([kind, n]) => `${n} public ${kind}${n > 1 ? 's' : ''}`)
      .join(', ');
  }

  async _fetchHome(contract) {
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
      // App unreachable / timeout — identity still indexes without sessions.
      return null;
    }
  }
}
