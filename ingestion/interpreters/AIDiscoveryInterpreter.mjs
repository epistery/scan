import DomainDiscovery from '../DomainDiscovery.mjs';

/**
 * AIDiscoveryInterpreter
 *
 * Wraps DomainDiscovery into the unified interpreter interface.
 * A domain publishing /.well-known/ai is an entity just like a blockchain contract —
 * DNS is the trust substrate instead of a chain.
 */
export default class AIDiscoveryInterpreter {
  constructor(database, config = {}) {
    this.database = database;
    this.type = 'AIDiscovery';
    this.domainDiscovery = new DomainDiscovery(database, config);
  }

  getSchema() {
    return { source: 'web', tabs: ['overview', 'pages', 'apis', 'policies', 'concepts', 'raw'] };
  }

  /**
   * Sync a domain — address is the domain name
   */
  async sync(address) {
    const result = await this.domainDiscovery.syncDomain(address);
    return result ? result.entity : null;
  }

  /**
   * No-op for web entities. Changes are detected during sync() —
   * checkDomain already records discovery.indexed / discovery.updated events.
   */
  async processEvents() {
    return [];
  }

  async getSummary(address) {
    const entity = await this.database.getEntity(address);
    if (!entity) return null;

    const manifest = entity.metadata?.manifest || {};
    return {
      address,
      type: this.type,
      chain: 'web',
      domain: entity.metadata?.domain,
      organization: manifest.organization?.name,
      capabilities: Object.keys(manifest.capabilities || {}),
      verification: entity.metadata?.verification
    };
  }
}
