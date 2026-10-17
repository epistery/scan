/**
 * DomainReport — everything scan can observe about a domain, gathered at once.
 *
 *   index     what scan's index and crawl hold (HostIndex): entities, rung,
 *             the /.well-known/ai finding, related hosts
 *   dns       the records the domain publishes (probes/dns)
 *   tls       the certificate it presents (probes/tls)
 *   epistery  its /.well-known/epistery host wallet, checked against the host
 *             its indexed domain contract names (probes/episteryHost)
 *
 * A name that does not resolve is reported as exactly that — no crawl, no
 * handshake. Every part carries the time it was observed.
 */
import HostIndex from './HostIndex.mjs';
import { probeDns } from './probes/dns.mjs';
import { probeTls } from './probes/tls.mjs';
import { probeEpisteryHost } from './probes/episteryHost.mjs';

export default class DomainReport {
  constructor(db, domainDiscovery) {
    this.index = new HostIndex(db, domainDiscovery);
  }

  async report(host) {
    const dns = await probeDns(host);
    const live = dns.resolves;
    const [index, tls, epistery] = await Promise.all([
      this.index.host(host, { crawl: live }),
      live ? probeTls(host) : null,
      live ? probeEpisteryHost(host) : null
    ]);

    // The contract's side of the host binding: the wallet it names as host.
    const agentHosts = index.entities
      .filter(e => e.type === 'Agent' && e.metadata?.host)
      .map(e => e.metadata.host.toLowerCase());
    if (epistery?.present && agentHosts.length) {
      epistery.matchesAgentHost = agentHosts.includes(epistery.wallet.toLowerCase());
    }
    return { host, index, dns, tls, epistery };
  }
}
