/**
 * IdentityContractInterpreter
 *
 * Interprets IdentityContract.sol — owner + rivets[] (1-of-N multisig) identity.
 *
 * Supports both contract variants currently deployed:
 *   - V1 / "2.0.0"    rootz/epistery/contracts/IdentityContract.sol
 *   - V3 / "3.0.0-chat" epistery/chat/contracts/IdentityContract.sol
 *
 * V3 adds messaging extensions on top of V1: executeTransaction,
 * receiveMessage, registerPublicKey, plus a per-rivet ECDH public-key
 * registry and an incoming-message counter. All V3 reads are attempted
 * defensively so V1 contracts still sync cleanly.
 */
export default class IdentityContractInterpreter {
  constructor(connector, database) {
    this.connector = connector;
    this.database = database;
    this.type = 'IdentityContract';

    this.abi = [
      // shared (V1 + V3)
      'event IdentityCreated(address indexed owner, address indexed firstRivet, string name, string domain, uint256 timestamp)',
      'event IdentityNameUpdated(string oldName, string newName, uint256 timestamp)',
      'event RivetAdded(address indexed rivet, address indexed addedBy, string name, uint256 timestamp)',
      'event RivetRemoved(address indexed rivet, address indexed removedBy, uint256 timestamp)',
      'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner, uint256 timestamp)',
      'event NotabotScoreUpdated(address indexed rivet, uint256 points, uint256 eventCount, uint256 timestamp)',
      'event AttributeSet(string indexed key, bool isPublic, uint256 timestamp)',
      // V3 only
      'event TransactionExecuted(address indexed target, uint256 value, bytes data, address indexed sender, uint256 timestamp)',
      'event MessageReceived(address indexed from, bytes data, uint256 value, uint256 indexed messageIndex, uint256 timestamp)',
      'event PublicKeyRegistered(address indexed rivet, string publicKey, uint256 timestamp)',

      'function VERSION() view returns (string)',
      'function owner() view returns (address)',
      'function identityName() view returns (string)',
      'function domain() view returns (string)',
      'function getFullName() view returns (string)',
      'function getRivets() view returns (address[])',
      'function getRivetCount() view returns (uint256)',
      'function getRivetsWithNames() view returns (address[] addresses, string[] names)',
      'function rivetNames(address) view returns (string)',
      // V3 only
      'function messageCount() view returns (uint256)',
      'function getPublicKey(address rivet) view returns (string)'
    ];
  }

  getEventFilters() {
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
    const metadata = {};

    const tryRead = async (fn) => { try { return await fn(); } catch (e) { return undefined; } };

    metadata.version       = await tryRead(() => contract.VERSION());
    metadata.owner         = await tryRead(() => contract.owner());
    metadata.identityName  = await tryRead(() => contract.identityName());
    metadata.domain        = await tryRead(() => contract.domain());
    metadata.fullName      = await tryRead(() => contract.getFullName());

    const rivets = await tryRead(() => contract.getRivets());
    if (!rivets) {
      throw new Error(`getRivets() failed — ${address} is not an IdentityContract`);
    }
    metadata.rivets = rivets.map(r => r.toLowerCase());
    metadata.rivetCount = metadata.rivets.length;

    // V3-only fields. Undefined on V1 — that's the signal we use to brand the variant.
    metadata.messageCount = await tryRead(async () => Number(await contract.messageCount()));
    const isV3 = metadata.messageCount !== undefined ||
                 (typeof metadata.version === 'string' && metadata.version.includes('chat'));
    metadata.variant = isV3 ? 'v3-chat' : 'v1';

    if (isV3) {
      const publicKeys = {};
      for (const rivet of metadata.rivets) {
        const key = await tryRead(() => contract.getPublicKey(rivet));
        if (key) publicKeys[rivet] = key;
      }
      metadata.rivetPublicKeys = publicKeys;
    }

    if (metadata.owner) metadata.owner = metadata.owner.toLowerCase();

    const entity = await this.database.saveEntity({
      address,
      type: this.type,
      chain,
      metadata
    });

    console.log(
      `[interpreter:identity] Synced ${address} on ${chain}` +
      ` (variant: ${metadata.variant}, rivets: ${metadata.rivetCount}` +
      (isV3 ? `, msgs: ${metadata.messageCount})` : ')')
    );
    return entity;
  }

  async processEvents(address, chain, fromBlock, toBlock) {
    const connector = this.connector[chain];
    if (!connector) throw new Error(`No connector for chain: ${chain}`);

    const eventRecords = [];

    for (const eventFilter of this.getEventFilters()) {
      const events = await connector.queryEvents(address, eventFilter, fromBlock, toBlock);

      for (const event of events) {
        event.timestamp = await connector.getBlockTimestamp(event.blockNumber);

        const args = {};
        for (const [k, v] of Object.entries(event.args || {})) {
          // ethers v6 returns BigInts for uint params; stringify so MongoDB can store them.
          args[k] = typeof v === 'bigint' ? v.toString() : v;
        }

        eventRecords.push({
          source: 'blockchain',
          entityId: address,
          type: `identity.${event.event}`,
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

  async getSummary(address, chain) {
    const entity = await this.database.getEntity(address);
    if (!entity) return null;

    const events = await this.database.getEntityEvents(address, { limit: 10 });
    const m = entity.metadata || {};

    return {
      address,
      type: this.type,
      chain,
      variant: m.variant,
      version: m.version,
      owner: m.owner,
      identityName: m.identityName,
      domain: m.domain,
      fullName: m.fullName,
      rivets: m.rivets,
      rivetCount: m.rivetCount,
      messageCount: m.messageCount,
      rivetPublicKeys: m.rivetPublicKeys,
      recentEvents: events.length,
      lastActivity: events[0]?.timestamp
    };
  }
}