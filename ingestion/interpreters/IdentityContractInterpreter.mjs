import { computeTrustScore } from '../../lib/Posture.mjs';
import { buildObjectDigest } from '../../lib/SchemaMaps.mjs';
import { explorerUrl, shortAddress } from '../../lib/Explorers.mjs';
import { verifySessionDeclaration } from '../../lib/SessionDeclaration.mjs';

const IDENTITY_SCHEMA = 'https://epistery.com/schema/Identity';

// EpisteryAccess vocabulary — the contract's own constants, mirrored here
// because scan reads the chain rather than importing the app.
const PROFILE_SECTION = '_profile';
// The "default" ACL entry (EpisteryAccess.DEFAULT_MEMBER): the role EVERY
// address holds on a section unless explicitly granted. This is how a session
// declares itself open on chain — no off-chain visibility flag exists, and
// scan never invents one. See console/client/epistery.mjs (setSectionDefault).
const DEFAULT_MEMBER = '0x00000000000000000000000000000000defa0117';
const ROLE_NAME = { 0: 'none', 1: 'read', 2: 'write', 3: 'admin', 4: 'owner' };

// A section named by a 0x… address IS a session (the session id); anything else
// is the contract's own reserved storage (today only `_profile`).
const SESSION_SECTION = /^0x[0-9a-fA-F]{40}$/;

const HOME_TIMEOUT_MS = 8000;

/**
 * IdentityContractInterpreter
 *
 * Interprets an epistery IdentityContract — the collection of interchangeable
 * device keys (rivets) that IS a person or an agent on chain.
 *
 * Three deployed generations, read from one ABI and branded by what answers:
 *
 *   `access`  IdentityContract on {EpisteryAccess} (current — epistery/console).
 *             Rivets + host + a `_profile` section holding the world-readable
 *             display name, plus one SECTION PER SESSION carrying that session's
 *             ACL. `getSectionNames()` is the capability gate: it exists only on
 *             this model, and the relay uses the same probe (relay/index.mjs →
 *             readIdentityMeta) so scan and relay agree on what a contract is.
 *   `chat-v3` the messaging generation (owner + identityName + message counter).
 *   `legacy`  the original owner + rivets[] contract.
 *
 * Two facts about an identity live in two places, and the card needs both:
 *
 *   - the CHAIN says which devices can act for it, which sections exist, and
 *     what role the world holds on each (the `default` ACL entry). That is
 *     re-readable by anyone; scan's copy is a cache.
 *   - the identity's OWN HOST says what those sessions are — kind, name, title.
 *     Scan asks the host the identity is namespaced under (the `identities`
 *     directory row the relay maintains) and links back to the identity's own
 *     page there. It never restates a session's content, and the card's live
 *     pull goes to that host directly, in the viewer's own identity, so a
 *     visitor sees exactly the sessions THEY may open.
 */
export default class IdentityContractInterpreter {
  constructor(connector, database) {
    this.connector = connector;
    this.database = database;
    this.type = 'IdentityContract';
    // address → 'access' | 'chat-v3' | 'legacy'. Set by sync(), read by
    // processEvents() so each generation scans only its OWN event signatures
    // (an unmatched signature is a wasted getLogs scan on every poll).
    this._models = new Map();

    this.abi = [
      // ── reads: EpisteryAccess generation ────────────────────────────────
      'function creator() view returns (address)',
      'function host() view returns (address)',
      'function profileName() view returns (string)',
      'function rivetCount() view returns (uint256)',
      'function rivetAddedAt(address) view returns (uint256)',
      'function rivetPublicKeys(address) view returns (string)',
      'function removeRivetThreshold() view returns (uint256)',
      'function getSectionNames() view returns (string[])',
      'function getACL(string) view returns (tuple(address addr, string name, uint8 role, string meta)[])',
      'function getPublic(string, string) view returns (string)',
      // the session-admin check a session declaration is verified against
      'function authorized(string section, address who, uint8 minRole) view returns (bool)',
      // ── reads: shared across generations ────────────────────────────────
      'function getRivets() view returns (address[])',
      'function rivetNames(address) view returns (string)',
      'function messageCount() view returns (uint256)',
      // ── reads: chat-v3 / legacy only ────────────────────────────────────
      'function VERSION() view returns (string)',
      'function owner() view returns (address)',
      'function identityName() view returns (string)',
      'function domain() view returns (string)',
      'function getFullName() view returns (string)',
      'function getPublicKey(address rivet) view returns (string)'
    ];
  }

  /**
   * Event signatures to scan, per generation. The two generations share event
   * NAMES with different parameter lists (IdentityCreated, TransactionExecuted,
   * MessageReceived) — different topic0, so the wrong list finds nothing and
   * costs a full range scan. Hence: one list per model, never the union.
   */
  getEventFilters(model = 'access') {
    if (model === 'access') {
      return [
        'IdentityCreated(address indexed creator, address indexed host, uint256 timestamp)',
        'RivetAdded(address indexed rivet, address indexed addedBy, string name, uint256 timestamp)',
        'RivetRemoved(address indexed rivet, address indexed removedBy, uint256 timestamp)',
        'HostChanged(address indexed previousHost, address indexed newHost, address indexed by)',
        'PublicKeyRegistered(address indexed rivet, string publicKey, uint256 timestamp)',
        // EpisteryAccess — the access story: who was granted what, on which
        // section, and when a section's public attributes moved.
        'MemberSet(string section, address indexed addr, uint8 role, address indexed by)',
        'MemberRemoved(string section, address indexed addr, address indexed by)',
        'PublicSet(string section, string key, address indexed by)',
        'InviteRedeemed(bytes32 indexed codeHash, string section, address indexed redeemer)'
        // Deliberately not scanned: the contract acting as a smart wallet
        // (TransactionExecuted, ETHSent, TokenSent, MessageReceived) and
        // InviteCreated. Every signature costs its own range query on every
        // poll of every identity, and none of these change what the identity
        // is — its devices, its sections, and who may open them. They are
        // wallet movements, whole and re-readable on the explorer the card
        // already links to.
      ];
    }
    return [
      'IdentityCreated(address indexed owner, address indexed firstRivet, string name, string domain, uint256 timestamp)',
      'IdentityNameUpdated(string oldName, string newName, uint256 timestamp)',
      'RivetAdded(address indexed rivet, address indexed addedBy, string name, uint256 timestamp)',
      'RivetRemoved(address indexed rivet, address indexed removedBy, uint256 timestamp)',
      'OwnershipTransferred(address indexed previousOwner, address indexed newOwner, uint256 timestamp)',
      'NotabotScoreUpdated(address indexed rivet, uint256 points, uint256 eventCount, uint256 timestamp)',
      'AttributeSet(string indexed key, bool isPublic, uint256 timestamp)',
      'TransactionExecuted(address indexed target, uint256 value, bytes data, address indexed sender, uint256 timestamp)',
      'MessageReceived(address indexed from, bytes data, uint256 value, uint256 indexed messageIndex, uint256 timestamp)',
      'PublicKeyRegistered(address indexed rivet, string publicKey, uint256 timestamp)'
    ];
  }

  getSchema() {
    return { source: 'blockchain', tabs: ['overview', 'transactions', 'events', 'data'] };
  }

  async sync(address, chain) {
    const connector = this.connector[chain];
    if (!connector) throw new Error(`No connector for chain: ${chain}`);

    const contract = connector.getContract(address, this.abi);
    const tryRead = async (fn) => { try { return await fn(); } catch (e) { return undefined; } };
    const metadata = {};

    // Capability gate — getSectionNames() exists ONLY on the EpisteryAccess
    // generation. Probing with creator()/owner() misclassifies, because the
    // chat generation has both (the mistake that made the relay read every old
    // contract as new).
    const sections = await tryRead(() => contract.getSectionNames());
    const isAccess = Array.isArray(sections);

    const rivetAddrs = await tryRead(() => contract.getRivets());
    if (!rivetAddrs) {
      throw new Error(`getRivets() failed — ${address} is not an IdentityContract`);
    }

    metadata.model = isAccess ? 'access' : null;   // set below for the older ones
    metadata.rivets = rivetAddrs.map(r => r.toLowerCase());
    metadata.rivetCount = metadata.rivets.length;

    // Every device that can act as this identity, with the name its owner gave
    // it and the day it was added. `key` is the device's published encryption
    // key — a rivet publishes one only if it can be wrapped to (a web3 wallet
    // rivet cannot), so its absence is a fact, not a gap.
    metadata.devices = [];
    for (const addr of rivetAddrs) {
      const [name, addedAt, pub] = await Promise.all([
        tryRead(() => contract.rivetNames(addr)),
        tryRead(async () => Number(await contract.rivetAddedAt(addr))),
        tryRead(() => contract.rivetPublicKeys(addr))
      ]);
      metadata.devices.push({
        address: addr.toLowerCase(),
        name: (name || '').trim() || null,
        added: addedAt ? new Date(addedAt * 1000).toISOString() : null,
        key: !!(pub && pub !== '0x')
      });
    }

    if (isAccess) {
      metadata.model = 'access';
      metadata.creator   = (await tryRead(() => contract.creator()))?.toLowerCase() || null;
      metadata.host      = (await tryRead(() => contract.host()))?.toLowerCase() || null;
      if (metadata.host === '0x0000000000000000000000000000000000000000') metadata.host = null;
      metadata.identityName = ((await tryRead(() => contract.profileName())) || '').trim() || null;
      metadata.removeRivetThreshold = await tryRead(async () => Number(await contract.removeRivetThreshold()));
      metadata.messageCount = await tryRead(async () => Number(await contract.messageCount()));
      metadata.sections = await this._readSections(contract, sections, tryRead);
    } else {
      // chat-v3 / legacy: owner-plus-rivets, name and domain held on the
      // contract itself. Read exactly as before so old contracts keep syncing.
      metadata.version      = await tryRead(() => contract.VERSION());
      metadata.creator      = (await tryRead(() => contract.owner()))?.toLowerCase() || null;
      metadata.identityName = await tryRead(() => contract.identityName());
      metadata.domain       = await tryRead(() => contract.domain());
      metadata.fullName     = await tryRead(() => contract.getFullName());
      metadata.messageCount = await tryRead(async () => Number(await contract.messageCount()));
      metadata.model = (metadata.messageCount !== undefined ||
                        (typeof metadata.version === 'string' && metadata.version.includes('chat')))
        ? 'chat-v3' : 'legacy';
      metadata.sections = [];
      if (metadata.model === 'chat-v3') {
        for (const d of metadata.devices) {
          if (d.key) continue;                       // already answered by rivetPublicKeys
          const k = await tryRead(() => contract.getPublicKey(d.address));
          d.key = !!(k && k !== '0x');
        }
      }
    }

    // ── the identity's namespace: which host answers for it ────────────────
    // The relay writes one directory row per minted contract into scan's own
    // `identities` collection: { address, name, domain }. That domain IS the
    // host the identity is named under (epistery.com today, epistery.app for
    // the older ones), so the profile link and the home read follow the row
    // rather than one configured URL. No row → no name and no profile link;
    // we do not guess a host.
    const directory = await this._directoryRow(address);
    metadata.name = metadata.identityName || directory?.name || null;
    metadata.namespace = directory?.domain || metadata.domain || null;
    metadata.profileUrl = (metadata.namespace && metadata.name)
      ? `https://${metadata.namespace}/@${metadata.name}` : null;
    metadata.homeUrl = metadata.namespace
      ? `https://${metadata.namespace}/api/contracts/${address}/home` : null;
    // `metadata.domain` is the collection-wide "which domain is this entity's"
    // field — indexed, and what search and the domain-binding signal read. For
    // the current generation that is the namespace; the older ones declare
    // their own on the contract and keep it.

    // ── what the identity itself declares ──────────────────────────────────
    // Its host's open contract-home read: the sessions it offers a walk-up
    // visitor, with the kind/name/title only the owner knows. Anonymous here —
    // a card's live pull to the same URL, carrying the viewer's own identity,
    // is what widens the list for someone who holds a private role.
    const declared = metadata.homeUrl ? await this._fetchHome(metadata.homeUrl) : null;
    metadata.sessions = this._mergeSessions(address, metadata, declared);
    // A session's own declaration is vouched for by THIS contract, not by the
    // host that served it: check each one against the chain (see
    // lib/SessionDeclaration.mjs). Only sessions the chain holds are checked.
    for (const s of metadata.sessions) {
      if (!s.declaration || !s.onChain) continue;
      s.declarationFacts = await verifySessionDeclaration({ contractAddress: address, session: s.id, declaration: s.declaration, contract });
    }

    const now = new Date();
    // Where the domain shown for this entity came from. `contract` means the
    // contract itself declares it (the older generation's own `domain()`).
    // `namespace` is our directory row — where a name was registered, which is not
    // something the identity said. Search renders one field, so it must say which.
    metadata.domainSource = metadata.domain ? 'contract' : (metadata.namespace ? 'namespace' : null);
    if (!metadata.domain) metadata.domain = metadata.namespace;
    const signals = { contractExists: { present: true, at: now, address } };
    // The identity's host confirms the same contract the chain describes —
    // the two-sided binding between a name on a host and a contract on chain.
    signals.platform = {
      present: !!declared?.isContract,
      at: now,
      host: metadata.namespace || null
    };
    // domainBinding — only when the CONTRACT declares a domain itself.
    //
    // This used to be "an AIDiscovery entity exists for the namespace we filed
    // this contract under", which is us confirming our own record: true for every
    // identity named on a domain that publishes a manifest, whatever the contract
    // said. The current generation declares nothing on chain, so the honest answer
    // for it is absent-with-a-reason, not a free 25 points.
    signals.domainBinding = (metadata.domainSource === 'contract' && metadata.domain)
      ? { present: true, at: now, domain: metadata.domain, source: 'contract' }
      : { present: false, at: now, reason: 'the contract declares no domain of its own' };
    metadata.signals = signals;
    metadata.trustScore = computeTrustScore(signals);
    // Where the displayed domain came from. `attachment` is a fact the contract
    // states and the domain signed. `namespace` is our own directory row — where a
    // name was registered, not something the identity declared. Search renders one
    // field, so it has to say which of the two it is holding.


    const openSessions = metadata.sessions.filter(s => s.defaultRole && s.defaultRole !== 'none');
    metadata.object = buildObjectDigest({
      type: 'identity',
      schema: IDENTITY_SCHEMA,
      jsonld: {
        '@context': 'https://epistery.com/schema',
        '@type': 'Identity',
        '@id': address,
        name: metadata.name || `Identity ${shortAddress(address)}`,
        address,
        model: metadata.model,
        version: metadata.version || null,
        namespace: metadata.namespace || null,
        profileUrl: metadata.profileUrl,
        home: metadata.homeUrl,
        creator: metadata.creator,
        creatorShort: shortAddress(metadata.creator),
        host: metadata.host || null,
        hostShort: shortAddress(metadata.host),
        rivets: { count: metadata.rivetCount, devices: metadata.devices },
        sessions: metadata.sessions,
        sessionCount: metadata.sessions.length,
        openSessionCount: openSessions.length,
        removeRivetThreshold: metadata.removeRivetThreshold ?? null,
        messageCount: metadata.messageCount ?? null,
        chain,
        url: explorerUrl(chain, address),
        // Membership and session rosters move without scan hearing about it —
        // pull the locator (the identity's own home read) to trust them.
        volatile: ['sessions', 'rivets']
      },
      extraKeywords: ['identity', 'rivets', ...metadata.sessions.map(s => s.kind).filter(Boolean)]
    });

    const entity = await this.database.saveEntity({
      address,
      type: this.type,
      chain,
      metadata
    });

    this._models.set(address.toLowerCase(), metadata.model);
    console.log(
      `[interpreter:identity] Synced ${address} on ${chain}` +
      ` (${metadata.model}, ${metadata.name || 'unnamed'}, rivets: ${metadata.rivetCount},` +
      ` sessions: ${openSessions.length}/${metadata.sessions.length} open)`
    );
    return entity;
  }

  /**
   * Each session on this contract is a SECTION, and the section's ACL is the
   * whole access answer: the reserved `default` entry is the role the world
   * holds (absent = private), every other entry is a named collaborator. We
   * keep the counts and the public role — never the roster, which is the
   * chain's to serve and the identity's to grant.
   */
  async _readSections(contract, sectionNames, tryRead) {
    const out = [];
    for (const section of sectionNames) {
      if (section === PROFILE_SECTION) continue;
      const acl = await tryRead(() => contract.getACL(section)) || [];
      let defaultRole = 'none';
      let members = 0;
      for (const entry of acl) {
        if (entry.addr?.toLowerCase() === DEFAULT_MEMBER) defaultRole = ROLE_NAME[Number(entry.role)] || 'none';
        else members++;
      }
      out.push({
        section,
        isSession: SESSION_SECTION.test(section),
        defaultRole,
        members
      });
    }
    return out;
  }

  /** The relay-maintained directory row for this contract: its name and namespace. */
  async _directoryRow(address) {
    try {
      return await this.database.db.collection('identities')
        .findOne({ address: new RegExp(`^${address}$`, 'i') });
    } catch (e) {
      console.warn(`[interpreter:identity] identities directory unreadable: ${e.message}`);
      return null;
    }
  }

  /**
   * The identity's own contract-home read, served by the host it is named
   * under. Open (no auth) and answers for the walk-up visitor: every session
   * whose on-chain default role admits anyone. Unreachable host → null, and
   * the identity still indexes with its chain facts.
   */
  async _fetchHome(url) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), HOME_TIMEOUT_MS);
      const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      clearTimeout(t);
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  /**
   * One session list from the two halves. The chain names the sections and
   * their public role; the identity's host names the session — kind, title,
   * description — and gives it a page and an MCP endpoint. A declaration with
   * no matching section stays listed (`onChain: false`): scan reports what
   * each side says, it does not adjudicate between them.
   */
  _mergeSessions(address, metadata, home) {
    const chainSessions = (metadata.sections || []).filter(s => s.isSession);
    const byId = new Map(chainSessions.map(s => [s.section.toLowerCase(), s]));
    const host = metadata.namespace;
    const ownerName = metadata.name;
    // The console answers `sessions`; the older app answered `publicSessions`.
    const declared = home?.sessions || home?.publicSessions || [];
    const out = [];

    for (const d of declared) {
      const id = d.id;
      if (!id) continue;
      const onChain = byId.get(String(id).toLowerCase());
      if (onChain) byId.delete(String(id).toLowerCase());
      out.push({
        id,
        kind: d.kind || null,
        name: d.name || null,
        title: d.title || null,
        description: d.description || null,
        // The chain's answer wins where both speak — it is the one anybody can
        // re-read. The declaration fills in only what the chain does not hold.
        defaultRole: onChain ? onChain.defaultRole : (d.defaultRole || null),
        members: onChain ? onChain.members : (d.memberCount ?? null),
        onChain: !!onChain,
        url: this._sessionUrl(host, ownerName, address, d),
        mcp: (host && d.kind) ? `https://${host}/p/${d.kind}/${address}/${id}/mcp` : null,
        // The session's own signed declaration, verbatim; verified in sync().
        declaration: d.declaration || null
      });
    }

    // Sections the chain holds that the host did not declare — a private
    // session, or one on a host scan could not reach. Reported as the section
    // it is, with nothing invented about what lives inside it.
    for (const s of byId.values()) {
      out.push({
        id: s.section,
        kind: null, name: null, title: null, description: null,
        defaultRole: s.defaultRole,
        members: s.members,
        onChain: true,
        undeclared: true,
        url: null,
        mcp: null
      });
    }
    return out;
  }

  /**
   * The session's page on the identity's own host — the memorable form
   * (epistery.com/@mjs/recipes) when the owner and the session are both named,
   * otherwise the addressed form both hosts serve.
   */
  _sessionUrl(host, ownerName, address, session) {
    if (!host) return null;
    if (ownerName && session.name) return `https://${host}/@${ownerName}/${session.name}`;
    return `https://${host}/#/s/${address}/${session.id}`;
  }

  async processEvents(address, chain, fromBlock, toBlock) {
    const connector = this.connector[chain];
    if (!connector) throw new Error(`No connector for chain: ${chain}`);

    const model = await this._modelOf(address);
    const eventRecords = [];

    for (const eventFilter of this.getEventFilters(model)) {
      const events = await connector.queryEvents(address, eventFilter, fromBlock, toBlock);

      for (const event of events) {
        event.timestamp = await connector.getBlockTimestamp(event.blockNumber);

        // ethers v6: args is a Result — named keys come from toObject(), and
        // uint params arrive as BigInt, which MongoDB cannot store.
        const raw = typeof event.args?.toObject === 'function' ? event.args.toObject() : (event.args || {});
        const args = {};
        for (const [k, v] of Object.entries(raw)) {
          args[k] = typeof v === 'bigint' ? v.toString() : v;
        }

        eventRecords.push({
          source: 'blockchain',
          entityId: address,
          // v6 names the event on the log itself; `event.event` was v5 and
          // stamped every identity record as `identity.undefined`.
          type: `identity.${event.eventName || event.fragment?.name || 'unknown'}`,
          chain,
          data: {
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            ...args
          },
          timestamp: event.timestamp
        });
      }
    }

    if (eventRecords.length > 0) {
      await this.database.recordEvents(eventRecords);
      console.log(`[interpreter:identity] Processed ${eventRecords.length} events for ${address}`);
    }

    return eventRecords;
  }

  /**
   * Which generation this contract is — from the last sync, the stored entity,
   * or (first sight) unknown, in which case we scan as the current model. The
   * next sync stamps it.
   */
  async _modelOf(address) {
    const key = address.toLowerCase();
    if (this._models.has(key)) return this._models.get(key);
    const entity = await this.database.getEntity(address).catch(() => null);
    const model = entity?.metadata?.model
      || (entity?.metadata?.variant === 'v1' ? 'legacy' : null)
      || (entity?.metadata?.variant === 'v3-chat' ? 'chat-v3' : null)
      || 'access';
    this._models.set(key, model);
    return model;
  }

  async getSummary(address, chain) {
    const entity = await this.database.getEntity(address);
    if (!entity) return null;

    const events = await this.database.getEntityEvents(address, { limit: 10 });
    const m = entity.metadata || {};

    return {
      address,
      type: this.type,
      chain,
      model: m.model,
      version: m.version,
      name: m.name,
      namespace: m.namespace,
      profileUrl: m.profileUrl,
      creator: m.creator,
      host: m.host,
      rivets: m.rivets,
      rivetCount: m.rivetCount,
      devices: m.devices,
      sessions: m.sessions,
      messageCount: m.messageCount,
      recentEvents: events.length,
      lastActivity: events[0]?.timestamp
    };
  }
}
