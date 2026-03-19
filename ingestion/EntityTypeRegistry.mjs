/**
 * EntityTypeRegistry
 *
 * Maps entity type names to interpreter instances with source metadata.
 * Treats all entity types as first-class citizens — blockchain contracts
 * and web-discovered domains go through the same registry.
 */
export default class EntityTypeRegistry {
  constructor() {
    this.types = new Map();
  }

  /**
   * Register an interpreter for a type
   * @param {string} typeName - e.g. 'Agent', 'AIDiscovery'
   * @param {object} interpreter - must implement sync(), processEvents(), getSummary(), getSchema()
   * @param {object} meta - { source: 'blockchain'|'web' }
   */
  register(typeName, interpreter, meta = {}) {
    this.types.set(typeName, { interpreter, meta });
    console.log(`[registry] Registered ${typeName} (source: ${meta.source || 'unknown'})`);
  }

  get(typeName) {
    const entry = this.types.get(typeName);
    return entry ? entry.interpreter : null;
  }

  has(typeName) {
    return this.types.has(typeName);
  }

  list() {
    return Array.from(this.types.keys());
  }

  forSource(source) {
    const result = [];
    for (const [typeName, entry] of this.types) {
      if (entry.meta.source === source) {
        result.push({ typeName, interpreter: entry.interpreter });
      }
    }
    return result;
  }
}
