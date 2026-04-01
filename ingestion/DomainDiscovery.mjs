import crypto from 'crypto';
import dns from 'dns';

const dnsResolver = new dns.promises.Resolver();

/**
 * DomainDiscovery
 *
 * Discovers and indexes websites that publish /.well-known/ai manifests.
 * Follows a 4-step discovery chain (modeled after email's SPF/DKIM/DMARC):
 *
 *   1. Native:    GET https://{domain}/.well-known/ai
 *   2. Link tag:  Parse <link rel="ai-discovery"> from the domain's homepage
 *   3. Subdomain: GET https://ai.{domain}/.well-known/ai
 *   4. DNS TXT:   Lookup _ai.{domain} TXT record for delegation host
 *
 * After discovery, a TXT verification check runs independently to confirm
 * the domain owner has published an _ai TXT record (proof of authorization).
 */
export default class DomainDiscovery {
  constructor(database, config = {}) {
    this.database = database;
    this.pollInterval = config.pollInterval || 86400000; // 24 hours
    this.fetchTimeout = config.fetchTimeout || 10000; // 10 seconds
    this.seedDomains = config.seedDomains || ['epistery.io', 'rootz.global', 'geist.social', 'michael.sprague.com', 'findbet.com', 'libertyproject.com'];
    this.isRunning = false;
    this.pollTimer = null;
  }

  /**
   * Fetch a URL with Accept: application/json and timeout
   */
  async fetchJSON(url, retries = 1) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.fetchTimeout);

      try {
        // Use redirect:'manual' — some load balancers lose Accept header on redirect
        const response = await fetch(url, {
          headers: { 'Accept': 'application/json' },
          signal: controller.signal,
          redirect: 'manual'
        });

        // Follow redirects ourselves, preserving headers
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location) {
            clearTimeout(timeout);
            return await this.fetchJSON(new URL(location, url).href, 0);
          }
          return null;
        }

        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('json')) {
          // Some hosts need a moment to route properly — wait and retry
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          return null;
        }

        return await response.json();
      } catch (error) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        return null;
      } finally {
        clearTimeout(timeout);
      }
    }
    return null;
  }

  /**
   * Fetch a URL as text/html with same timeout/redirect pattern as fetchJSON
   */
  async fetchHTML(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeout);

    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'text/html' },
        signal: controller.signal,
        redirect: 'manual'
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          clearTimeout(timeout);
          return await this.fetchHTML(new URL(location, url).href);
        }
        return null;
      }

      if (!response.ok) return null;
      return await response.text();
    } catch (error) {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Step 2: Discover via <link rel="ai-discovery"> in the domain's homepage <head>
   */
  async discoverViaLinkTag(domain) {
    const html = await this.fetchHTML(`https://${domain}/`);
    if (!html) return null;

    // Extract <head> content to limit regex scope
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (!headMatch) return null;

    const linkMatch = headMatch[1].match(/<link[^>]+rel=["']ai-discovery["'][^>]*>/i);
    if (!linkMatch) return null;

    const hrefMatch = linkMatch[0].match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) return null;

    const manifestUrl = new URL(hrefMatch[1], `https://${domain}/`).href;
    console.log(`[discovery] ${domain}: found <link rel="ai-discovery"> → ${manifestUrl}`);

    const manifest = await this.fetchJSON(manifestUrl);
    return manifest ? { manifest, manifestUrl } : null;
  }

  /**
   * Step 3: Discover via ai.{domain} subdomain
   */
  async discoverViaSubdomain(domain) {
    const url = `https://ai.${domain}/.well-known/ai`;
    const manifest = await this.fetchJSON(url);
    if (manifest) {
      console.log(`[discovery] ${domain}: found manifest at ai.${domain}`);
      return { manifest, manifestUrl: url };
    }
    return null;
  }

  /**
   * Step 4: Discover via DNS TXT record at _ai.{domain}
   * Expects: v=aid1 host={host}
   * Then fetches: https://{host}/agent/rootz/ai-discovery/manifest?domain={domain}
   */
  async discoverViaDNSTxt(domain) {
    try {
      const records = await dnsResolver.resolveTxt(`_ai.${domain}`);
      // records is array of arrays (each TXT record is an array of strings)
      const flat = records.map(r => r.join('')).join(' ');
      const hostMatch = flat.match(/v=aid1\s+host=(\S+)/i);
      if (!hostMatch) return null;

      const host = hostMatch[1];
      const url = `https://${host}/agent/rootz/ai-discovery/manifest?domain=${domain}`;
      console.log(`[discovery] ${domain}: TXT record points to ${host}`);

      const manifest = await this.fetchJSON(url);
      return manifest ? { manifest, manifestUrl: url } : null;
    } catch (error) {
      // ENOTFOUND, ENODATA, etc. — no TXT record
      return null;
    }
  }

  /**
   * Verify _ai TXT record exists for a domain (independent of discovery method).
   * This is proof that the domain owner authorized AI discovery.
   */
  async verifyTxtRecord(domain) {
    const result = {
      hasTxtRecord: false,
      txtHost: null,
      txtRaw: null,
      checkedAt: new Date()
    };

    try {
      const records = await dnsResolver.resolveTxt(`_ai.${domain}`);
      const flat = records.map(r => r.join('')).join(' ');
      result.txtRaw = flat;
      result.hasTxtRecord = true;

      const hostMatch = flat.match(/v=aid1\s+host=(\S+)/i);
      if (hostMatch) {
        result.txtHost = hostMatch[1];
      }
    } catch (error) {
      // No TXT record — that's fine
    }

    return result;
  }

  /**
   * Sync a domain — fetch manifest, verify, store entity, record event.
   * This is the interpreter-compatible sync logic, called by AIDiscoveryInterpreter
   * and also by checkDomain for crawl-driven discovery.
   *
   * Returns { entity, manifest } or null if no manifest found.
   */
  async syncDomain(domain) {
    const now = new Date();

    // Try discovery methods in order, stop at first manifest
    let manifest = null;
    let discoveryMethod = null;
    let manifestUrl = null;

    // Step 1: Native /.well-known/ai
    const nativeUrl = `https://${domain}/.well-known/ai`;
    manifest = await this.fetchJSON(nativeUrl);
    if (manifest) {
      discoveryMethod = 'native';
      manifestUrl = nativeUrl;
    }

    // Step 2: <link rel="ai-discovery"> in homepage
    if (!manifest) {
      const linkResult = await this.discoverViaLinkTag(domain);
      if (linkResult) {
        manifest = linkResult.manifest;
        discoveryMethod = 'link-tag';
        manifestUrl = linkResult.manifestUrl;
      }
    }

    // Step 3: ai.{domain} subdomain
    if (!manifest) {
      const subResult = await this.discoverViaSubdomain(domain);
      if (subResult) {
        manifest = subResult.manifest;
        discoveryMethod = 'subdomain';
        manifestUrl = subResult.manifestUrl;
      }
    }

    // Step 4: DNS TXT delegation
    if (!manifest) {
      const txtResult = await this.discoverViaDNSTxt(domain);
      if (txtResult) {
        manifest = txtResult.manifest;
        discoveryMethod = 'dns-txt';
        manifestUrl = txtResult.manifestUrl;
      }
    }

    // Always run TXT verification regardless of discovery method
    const txtVerification = await this.verifyTxtRecord(domain);

    if (!manifest) {
      await this.database.recordEvent({
        source: 'discovery',
        entityId: domain,
        type: 'discovery.error',
        data: { domain, reason: 'No manifest found via native, link-tag, subdomain, or DNS TXT', txtVerification }
      });
      return null;
    }

    // Verify signature if present
    let verification = null;
    if (manifest._signature) {
      verification = await this.verifySignature(manifest);
    }

    // Build entity metadata
    const tiers = {
      discovery: { fetchedAt: now, data: manifest }
    };

    // Check and fetch additional tiers
    const capabilities = manifest.capabilities || {};

    if (capabilities.knowledge) {
      const knowledge = await this.fetchTier(domain, 'knowledge');
      if (knowledge) tiers.knowledge = { fetchedAt: now, data: knowledge };
    }

    if (capabilities.feed) {
      const feed = await this.fetchTier(domain, 'feed');
      if (feed) tiers.feed = { fetchedAt: now, data: feed };
    }

    if (capabilities.content) {
      const content = await this.fetchTier(domain, 'content');
      if (content) tiers.content = { fetchedAt: now, data: content };
    }

    // Check if entity already exists
    const existing = await this.database.getEntity(domain);
    const isNew = !existing;

    // Save entity
    const entity = await this.database.saveEntity({
      address: domain,
      _id: domain,
      type: 'AIDiscovery',
      chain: 'web',
      metadata: {
        manifest,
        tiers,
        verification,
        discoveryMethod,
        manifestUrl,
        txtVerification,
        domain
      }
    });

    // Record event
    await this.database.recordEvent({
      source: 'discovery',
      entityId: domain,
      type: isNew ? 'discovery.indexed' : 'discovery.updated',
      data: {
        domain,
        organization: manifest.organization?.name,
        capabilities: Object.keys(capabilities),
        tiersFound: Object.keys(tiers),
        signatureValid: verification?.hashValid || false,
        discoveryMethod,
        manifestUrl,
        txtVerified: txtVerification.hasTxtRecord
      }
    });

    console.log(`[discovery] ${domain}: ${isNew ? 'indexed' : 'updated'} via ${discoveryMethod} (tiers: ${Object.keys(tiers).join(', ')})`);

    return { entity, manifest };
  }

  /**
   * Check a domain for /.well-known/ai manifest
   * Manages crawl state around syncDomain
   */
  async checkDomain(domain) {
    console.log(`[discovery] Checking ${domain}...`);

    const now = new Date();
    const nextCheck = new Date(now.getTime() + this.pollInterval);

    const result = await this.syncDomain(domain);

    if (!result) {
      // Record failed crawl state
      await this.database.addDomain({
        domain,
        active: true,
        status: 'no-manifest',
        lastChecked: now,
        nextCheck
      });
      console.log(`[discovery] ${domain}: no manifest found`);
      return null;
    }

    // Update domain crawl state
    await this.database.addDomain({
      domain,
      active: true,
      status: 'indexed',
      discoveryMethod: result.entity?.metadata?.discoveryMethod || null,
      lastChecked: now,
      nextCheck
    });

    // Discover new domains from manifest links
    await this.discoverDomains(result.manifest, domain);

    return result.entity;
  }

  /**
   * Fetch a specific tier (knowledge, feed, content)
   */
  async fetchTier(domain, tier) {
    const data = await this.fetchJSON(`https://${domain}/.well-known/ai/${tier}`);
    if (data) {
      console.log(`[discovery] ${domain}: fetched ${tier} tier`);
    }
    return data;
  }

  /**
   * Extract new domains from partner/app URLs in a manifest
   */
  async discoverDomains(manifest, sourceDomain) {
    const urls = [];

    if (manifest.partners) {
      for (const partner of manifest.partners) {
        if (partner.url) urls.push(partner.url);
      }
    }

    if (manifest.applications) {
      for (const app of manifest.applications) {
        if (app.url) urls.push(app.url);
      }
    }

    for (const url of urls) {
      try {
        const hostname = new URL(url).hostname;
        if (hostname === sourceDomain) continue;

        // Only add if we haven't seen this domain
        const existing = await this.database.getDomain(hostname);
        if (!existing) {
          await this.database.addDomain({
            domain: hostname,
            active: true,
            status: 'pending',
            discoveredFrom: sourceDomain
          });
          console.log(`[discovery] Discovered ${hostname} from ${sourceDomain}`);
        }
      } catch (e) {
        // Invalid URL, skip
      }
    }
  }

  /**
   * Verify the _signature block of a manifest
   * 1. Clone manifest, remove _signature
   * 2. JSON.stringify with sorted keys
   * 3. SHA-256 hash
   * 4. Compare with _signature.contentHash
   * 5. Cross-reference digitalName with known DomainAgent entities
   */
  async verifySignature(manifest) {
    const result = {
      signed: false,
      hashValid: false,
      digitalNameMatch: false,
      checkedAt: new Date()
    };

    if (!manifest._signature) return result;

    result.signed = true;
    result.digitalName = manifest._signature.digitalName || null;
    result.method = manifest._signature.method || null;

    try {
      // Clone and remove _signature
      const clone = JSON.parse(JSON.stringify(manifest));
      delete clone._signature;

      // Deep sort keys recursively for canonical form
      const sortKeys = (obj) => {
        if (Array.isArray(obj)) return obj.map(sortKeys);
        if (obj && typeof obj === 'object') {
          return Object.keys(obj).sort().reduce((sorted, key) => {
            sorted[key] = sortKeys(obj[key]);
            return sorted;
          }, {});
        }
        return obj;
      };

      const canonical = JSON.stringify(sortKeys(clone));
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');

      // contentHash may have "sha256:" prefix
      const expected = (manifest._signature.contentHash || '').replace(/^sha256:/, '');
      result.hashValid = hash === expected;

      // Cross-reference digitalName with known Agent entities
      if (manifest._signature.digitalName) {
        const agent = await this.database.getEntity(manifest._signature.digitalName);
        result.digitalNameMatch = !!agent && agent.type === 'Agent';
      }
    } catch (error) {
      console.error(`[discovery] Signature verification error:`, error.message);
    }

    return result;
  }

  /**
   * Process all active domains due for checking
   */
  async processDomains() {
    const domains = await this.database.getActiveDomains();
    console.log(`[discovery] Processing ${domains.length} domains...`);

    for (const domainRecord of domains) {
      try {
        await this.checkDomain(domainRecord.domain);
      } catch (error) {
        console.error(`[discovery] Error processing ${domainRecord.domain}:`, error.message);
      }
    }
  }

  /**
   * Seed known domains on first start
   */
  async seedKnownDomains() {
    for (const domain of this.seedDomains) {
      const existing = await this.database.getDomain(domain);
      if (!existing) {
        await this.database.addDomain({
          domain,
          active: true,
          status: 'pending',
          discoveredFrom: 'seed'
        });
        console.log(`[discovery] Seeded domain: ${domain}`);
      }
    }
  }

  /**
   * Also check domains from DomainAgent contracts (entities with metadata.domain)
   */
  async discoverFromAgents() {
    const agents = await this.database.searchEntities(
      { type: 'Agent', 'metadata.domain': { $exists: true, $ne: '' } }
    );

    for (const agent of agents) {
      const domain = agent.metadata.domain;
      const existing = await this.database.getDomain(domain);
      if (!existing) {
        await this.database.addDomain({
          domain,
          active: true,
          status: 'pending',
          discoveredFrom: `agent:${agent.address}`
        });
        console.log(`[discovery] Discovered ${domain} from agent ${agent.address}`);
      }
    }
  }

  /**
   * Start polling
   */
  start() {
    if (this.isRunning) {
      console.warn('[discovery] Already running');
      return;
    }

    this.isRunning = true;
    console.log(`[discovery] Starting polling (interval: ${this.pollInterval}ms)`);

    this.pollTimer = setInterval(async () => {
      try {
        await this.discoverFromAgents();
        await this.processDomains();
      } catch (error) {
        console.error('[discovery] Poll error:', error);
      }
    }, this.pollInterval);

    // Run immediately on start
    (async () => {
      try {
        await this.seedKnownDomains();
        await this.discoverFromAgents();
        await this.processDomains();
      } catch (error) {
        console.error('[discovery] Initial poll error:', error);
      }
    })();
  }

  /**
   * Stop polling
   */
  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[discovery] Stopped polling');
  }
}
