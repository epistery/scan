/**
 * ServiceQuery — `@service-name query` delegates to a live MCP service through
 * the harness. Available only when a harness child serves the registry
 * (dormant in the current deployment), and listed in the guide only then.
 */
export default {
  kind: 'service',
  describe: '@service-name followed by a query — delegated to that live MCP service',
  available: (scan) => !!scan.harness,
  targets: (intent, scan) => (intent.service && scan.harness) ? [intent.service] : [],

  async run(service, scan, out, limit) {
    const delegated = await scan._delegateToService(service.name, service.query, limit);
    out.query = delegated.query;
    out.results.push(...delegated.results);
    Object.assign(out.meta, delegated.meta, { sources: delegated.meta.sources });
  },

  async example() {
    return null;
  }
};
