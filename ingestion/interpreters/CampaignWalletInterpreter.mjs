import { ethers } from 'ethers';
import { mapFor, projectSearch, projectCard } from '../../lib/SchemaMaps.mjs';

const CAMPAIGN_SCHEMA = 'https://epistery.com/schema/Campaign';

// Block-explorer address pages, per chain slug — the campaign's locator.
const EXPLORERS = {
  polygon: 'https://polygonscan.com/address/',
  'polygon-amoy': 'https://amoy.polygonscan.com/address/',
  ethereum: 'https://etherscan.io/address/',
  sepolia: 'https://sepolia.etherscan.io/address/',
  japanopenchain: 'https://explorer.japanopenchain.org/address/'
};

/** Wei → POL as a number (readable in summaries/facets; raw wei kept alongside). */
function pol(v) {
  if (v == null) return null;
  const n = Number(ethers.formatEther(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * CampaignWalletInterpreter
 *
 * Interprets Adnet campaign contracts. Current target is CampaignContract
 * (geistm/adnet-factory/contracts/CampaignContract.sol) — the contract IS the
 * campaign: budget, spent, rates, promotions, and the declared settlement rule
 * (`open` / `confirmedDomain` / `whitelisted`) all live on chain and are
 * re-readable by anyone; scan's copy is a cache of the contract's own facts.
 * Legacy CampaignWallet v2 contracts (BatchSubmitted era) still sync — reads
 * and event queries that don't exist on a given deployment simply no-op.
 *
 * The synced entity carries a metadata.object digest built through the public
 * Campaign schema map (schema/Campaign.json), so campaigns join the same
 * card/search path as every other signed object.
 */
export default class CampaignWalletInterpreter {
  constructor(connector, database, options = {}) {
    this.connector = connector;
    this.database = database;
    this.type = 'CampaignWallet';

    // The Agency's factory host — the serving surface whose public routes take
    // the campaign contract address as the universal locator (/render, /link).
    // Config `adnet.factory` overrides; today's one live factory is the
    // default. GET {factory}/render/{address} returns the ad fragment (and
    // records a served view); /link is the tracked click-through.
    this.factory = String(options.factory || 'https://adnet.geistm.com').replace(/\/+$/, '');

    this.abi = [
      // Current CampaignContract
      'event BatchSettled(address indexed publisher, address indexed submitter, uint256 impressions, uint256 clicks, uint256 payout, bytes32 batchId, string evidenceURI, bool publisherSigned)',
      'event BudgetWithdrawn(address indexed to, uint256 amount)',
      // Shared with legacy CampaignWallet v2
      'event BatchSubmitted(address indexed publisher, string ipfsCID, uint256 payout, bytes32 lastHash)',
      'event Withdrawn(address indexed publisher, uint256 amount)',
      'event PromotionAdded(string promotionId, string creative)',
      'event PromotionUpdated(uint256 indexed index, bool active)',
      'event CampaignPaused(address indexed by)',
      'event CampaignUnpaused(address indexed by)',
      'event BudgetAdded(address indexed from, uint256 amount)',
      'function name() view returns (string)',
      'function advertiser() view returns (string, address)',
      'function agency() view returns (address)',
      'function active() view returns (bool)',
      'function budget() view returns (uint256)',
      'function spent() view returns (uint256)',
      'function remaining() view returns (uint256)',
      'function pacing() view returns (uint256)',
      'function targetAudience() view returns (string)',
      'function impressionRate() view returns (uint256)',
      'function clickRate() view returns (uint256)',
      'function settlementRule() view returns (string)',
      'function getPromotionCount() view returns (uint256)',
      'function getPromotion(uint256) view returns (string, string, string, string, string, bool)'
    ];
  }

  getEventFilters() {
    return [
      'BatchSettled(address indexed publisher, address indexed submitter, uint256 impressions, uint256 clicks, uint256 payout, bytes32 batchId, string evidenceURI, bool publisherSigned)',
      'BudgetWithdrawn(address indexed to, uint256 amount)',
      'BatchSubmitted(address indexed publisher, string ipfsCID, uint256 payout, bytes32 lastHash)',
      'Withdrawn(address indexed publisher, uint256 amount)',
      'PromotionAdded(string promotionId, string creative)',
      'PromotionUpdated(uint256 indexed index, bool active)',
      'CampaignPaused(address indexed by)',
      'CampaignUnpaused(address indexed by)',
      'BudgetAdded(address indexed from, uint256 amount)'
    ];
  }

  getSchema() {
    return { source: 'blockchain', tabs: ['overview', 'transactions', 'events', 'data'] };
  }

  /**
   * Read current contract state and store the entity with its object digest.
   */
  async sync(address, chain) {
    const connector = this.connector[chain];
    if (!connector) throw new Error(`No connector for chain: ${chain}`);

    try {
      const contract = connector.getContract(address, this.abi);
      const metadata = {};
      const read = async (field, fn) => {
        try { metadata[field] = await fn(); } catch (e) { /* not on this deployment */ }
      };

      await read('name', () => contract.name());
      await read('advertiser', async () => {
        const a = await contract.advertiser();
        return { name: a[0], wallet: a[1] };
      });
      await read('agency', () => contract.agency());
      await read('active', () => contract.active());
      await read('budgetWei', async () => (await contract.budget()).toString());
      await read('spentWei', async () => (await contract.spent()).toString());
      await read('remainingWei', async () => (await contract.remaining()).toString());
      await read('pacing', async () => (await contract.pacing()).toString());
      await read('targetAudience', () => contract.targetAudience());
      await read('impressionRateWei', async () => (await contract.impressionRate()).toString());
      await read('clickRateWei', async () => (await contract.clickRate()).toString());
      await read('settlementRule', () => contract.settlementRule());
      await read('promotionCount', async () => (await contract.getPromotionCount()).toString());

      // Promotions — the declared creatives (capped; count stays exact above)
      const count = Math.min(parseInt(metadata.promotionCount || '0', 10) || 0, 8);
      if (count > 0) {
        metadata.promotions = [];
        for (let i = 0; i < count; i++) {
          try {
            const p = await contract.getPromotion(i);
            metadata.promotions.push({
              promotionId: p[0], creative: p[1], title: p[2],
              subtitle: p[3], link: p[4], active: p[5]
            });
          } catch (e) { break; }
        }
      }

      metadata.object = this._buildObjectDigest(address, chain, metadata);

      const entity = await this.database.saveEntity({
        address,
        type: this.type,
        chain,
        metadata
      });

      console.log(`[interpreter:campaign] Synced ${address} on ${chain} (${metadata.name || 'unnamed'}, rule=${metadata.settlementRule || '?'})`);
      return entity;
    } catch (error) {
      console.error(`[interpreter:campaign] Failed to sync ${address}:`, error.message);
      throw error;
    }
  }

  /**
   * Project the contract state into the epistery Campaign vocabulary and run
   * it through the public schema map — same digest shape as imported objects,
   * so campaigns search and render through the one unified path.
   */
  _buildObjectDigest(address, chain, m) {
    const jsonld = {
      '@context': 'https://epistery.com/schema',
      '@type': 'Campaign',
      name: m.name || `Campaign ${address.slice(0, 10)}…`,
      status: m.active === true ? 'active' : (m.active === false ? 'paused' : null),
      settlementRule: m.settlementRule || null,
      advertiser: m.advertiser || null,
      agency: m.agency || null,
      targetAudience: m.targetAudience || null,
      budget: {
        total: pol(m.budgetWei),
        spent: pol(m.spentWei),
        remaining: pol(m.remainingWei),
        currency: 'POL'
      },
      rates: {
        impression: pol(m.impressionRateWei),
        click: pol(m.clickRateWei),
        currency: 'POL'
      },
      promotions: (m.promotions || []).filter(p => p.active),
      chain,
      url: EXPLORERS[chain] ? `${EXPLORERS[chain]}${address}` : null,
      // The Factory's public routes, keyed off the contract address (the
      // universal locator). `render` serves the live ad fragment — fetching it
      // records a served view on the campaign — `link` is the tracked
      // click-through. A format segment may be inserted before the address
      // (render/card/{address}). `status` (the signed transparency read) is
      // declared in the whitepaper but not yet served by the factory; it joins
      // here when it answers.
      locators: {
        render: `${this.factory}/render/${address}`,
        link: `${this.factory}/link/${address}`
      }
    };

    const map = mapFor(CAMPAIGN_SCHEMA);
    const digest = map ? projectSearch(map, jsonld) : { title: jsonld.name, summary: null, keywords: [jsonld.name] };
    const card = map ? projectCard(map, jsonld) : null;
    return {
      type: 'campaign',
      schema: CAMPAIGN_SCHEMA,
      title: digest.title || jsonld.name,
      summary: digest.summary || null,
      keywords: [...new Set([...(digest.keywords || []).flatMap(k =>
        String(k).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1)
      ), 'campaign', 'adnet', 'advertising'])],
      jsonld,
      image: card?.image || null
    };
  }

  async processEvents(address, chain, fromBlock, toBlock) {
    const connector = this.connector[chain];
    if (!connector) throw new Error(`No connector for chain: ${chain}`);

    const eventRecords = [];

    for (const eventFilter of this.getEventFilters()) {
      // Add delay between event queries to avoid rate limiting
      if (eventRecords.length > 0) {
        const delay = chain === 'polygon' ? 500 : 200;
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const events = await connector.queryEvents(address, eventFilter, fromBlock, toBlock);

      for (const event of events) {
        event.timestamp = await connector.getBlockTimestamp(event.blockNumber);

        const record = {
          type: `campaign.${event.eventName}`,
          source: 'CampaignWallet',
          entityId: address,
          chain,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          timestamp: event.timestamp
        };

        if (event.eventName === 'BatchSettled') {
          // The canonical settlement record: named publisher, submitter
          // (the Agency), counts, payout, and the hash binding the on-chain
          // summary to the agency-signed evidence bundle.
          record.publisher = event.args.publisher;
          record.submitter = event.args.submitter;
          record.impressions = event.args.impressions.toString();
          record.clicks = event.args.clicks.toString();
          record.payout = event.args.payout.toString();
          record.batchId = event.args.batchId;
          record.evidenceURI = event.args.evidenceURI;
          record.publisherSigned = event.args.publisherSigned;
        } else if (event.eventName === 'BatchSubmitted') {
          record.publisher = event.args.publisher;
          record.ipfsCID = event.args.ipfsCID;
          record.payout = event.args.payout.toString();
          record.lastHash = event.args.lastHash;
        } else if (event.eventName === 'Withdrawn') {
          record.publisher = event.args.publisher;
          record.amount = event.args.amount.toString();
        } else if (event.eventName === 'BudgetWithdrawn') {
          record.to = event.args.to;
          record.amount = event.args.amount.toString();
        } else if (event.eventName === 'PromotionAdded') {
          record.promotionId = event.args.promotionId;
          record.creative = event.args.creative;
        } else if (event.eventName === 'PromotionUpdated') {
          record.index = event.args.index.toString();
          record.active = event.args.active;
        } else if (event.eventName === 'CampaignPaused') {
          record.by = event.args.by;
        } else if (event.eventName === 'CampaignUnpaused') {
          record.by = event.args.by;
        } else if (event.eventName === 'BudgetAdded') {
          record.from = event.args.from;
          record.amount = event.args.amount.toString();
        }

        eventRecords.push(record);
      }
    }

    console.log(`[interpreter:campaign] Processed ${eventRecords.length} events for ${address}`);
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
      name: m.name,
      advertiser: m.advertiser,
      agency: m.agency,
      active: m.active,
      settlementRule: m.settlementRule,
      budget: m.object?.jsonld?.budget || null,
      rates: m.object?.jsonld?.rates || null,
      promotionCount: m.promotionCount,
      recentEvents: events.length,
      lastActivity: events[0]?.timestamp
    };
  }
}
