/**
 * DataSourceInterpreter
 *
 * Entity interpreter for registered data source skills.
 * Data sources are external sites that publish skill manifests
 * (tool definitions, mission, topics) for AI agent discovery.
 * Registered via [datasources] in config.ini.
 */
export default class DataSourceInterpreter {
  constructor(database, domainDiscovery) {
    this.database = database;
    this.domainDiscovery = domainDiscovery;
    this.type = 'DataSource';
  }

  getSchema() {
    return { source: 'config', tabs: ['overview', 'tools', 'manifest'] };
  }

  async sync(address) {
    const ds = this.domainDiscovery.dataSources.find(d => d.name === address || d.domain === address);
    if (!ds) return null;

    const now = new Date();
    const entity = await this.database.saveEntity({
      address: ds.name,
      _id: ds.name,
      type: this.type,
      chain: 'web',
      metadata: {
        domain: ds.domain,
        url: ds.url,
        label: ds.label,
        topics: ds.topics,
        skillManifest: ds.skillManifest || null,
        lastSynced: now
      }
    });

    return entity;
  }

  async processEvents() {
    return [];
  }

  async getSummary(address) {
    const entity = await this.database.getEntity(address);
    if (!entity) return null;

    return {
      address,
      type: this.type,
      chain: 'web',
      domain: entity.metadata?.domain,
      label: entity.metadata?.label,
      topics: entity.metadata?.topics || [],
      tools: entity.metadata?.skillManifest?.tools || []
    };
  }
}
