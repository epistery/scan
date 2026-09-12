import { ethers } from 'ethers';

/**
 * ChainConnector
 *
 * Normalizes blockchain access across different chains.
 * Each connector provides a consistent interface for reading events and contract data.
 */
export default class ChainConnector {
  constructor(config) {
    this.chain = config.chain;
    this.rpcUrl = config.rpcUrl;
    this.chainId = config.chainId || null;
    this.provider = null;

    // Circuit breaker for event scans. When the RPC persistently refuses a
    // scan — a free-tier getLogs that rejects every range, or a dead endpoint —
    // we stop re-issuing the same doomed calls on every poll and fail fast
    // during a cool-down instead. Without this, one broken provider turns the
    // ingestion poll loop into an RPC flood (the 2026-08-30 drpc runaway).
    // Keyed per scan target so one bad contract can't mute the rest; any clean
    // scan clears it, so recovery is automatic once the RPC/owned node is up.
    this._scanBreaker = new Map(); // key -> { failures, openUntil }
  }

  /**
   * Connect to the blockchain.
   *
   * Uses staticNetwork to prevent ethers v6 from issuing ENS resolver(bytes32)
   * lookups on every call — those lookups hammer the RPC (and your Infura
   * quota) and fail on chains without ENS (e.g. Polygon).
   */
  async connect() {
    if (this.chainId) {
      const network = ethers.Network.from({ name: this.chain, chainId: this.chainId });
      this.provider = new ethers.JsonRpcProvider(this.rpcUrl, network, { staticNetwork: network });
    } else {
      // No chainId — fall back to auto-detect (will issue a couple of calls)
      this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
      const network = await this.provider.getNetwork();
      this.chainId = Number(network.chainId);
    }
    console.log(`[connector] Connected to ${this.chain} (chainId: ${this.chainId})`);
    return this;
  }

  /**
   * Get the current block number
   */
  async getCurrentBlock() {
    return await this.provider.getBlockNumber();
  }

  /**
   * Get contract instance
   */
  getContract(address, abi) {
    return new ethers.Contract(address, abi, this.provider);
  }

  /**
   * Query events from a contract over a block range.
   *
   * Two honest guarantees:
   *  1. It adapts to whatever getLogs range the *actual* provider will serve —
   *     shrinking the chunk when the RPC says the range/response is too large,
   *     so an owned node (no cap), Infura (10k cap) and a stingy free tier all
   *     work without a hand-tuned constant.
   *  2. It NEVER returns a partial result as if it were complete. If a window
   *     genuinely cannot be read, it THROWS. The caller then leaves its
   *     checkpoint where it is, so we re-read that window later instead of
   *     silently skipping chain history (a trust product cannot have gaps).
   *
   * A per-target circuit breaker turns a persistently-refusing RPC into a
   * couple of fail-fast throws per cool-down, not a poll-loop flood.
   */
  async queryEvents(address, eventFilter, fromBlock, toBlock) {
    const bkey = this._breakerKey(address, eventFilter);
    const br = this._scanBreaker.get(bkey);
    if (br && br.openUntil > Date.now()) {
      // Circuit open — this RPC has been refusing this scan. Fail fast with no
      // RPC call at all, so a broken/limited provider can't spin the poll loop.
      const secs = Math.ceil((br.openUntil - Date.now()) / 1000);
      throw new Error(`[connector:${this.chain}] scan circuit open for ${address} (${eventFilter}) — cooling down ${secs}s after ${br.failures} consecutive failure(s); not querying`);
    }

    const contract = new ethers.Contract(address, ['event ' + eventFilter], this.provider);
    const filter = contract.filters[eventFilter.split('(')[0]]();

    const MAX_CHUNK = 2000;   // Infura's Polygon getLogs ceiling; fine for owned nodes too.
    const MIN_CHUNK = 64;     // Floor: if even this is refused, the provider can't serve getLogs at all.
    const MAX_TRANSIENT_RETRIES = 4;
    const from = fromBlock || 0;
    const to = toBlock || await this.getCurrentBlock();

    const allEvents = [];
    let chunk = MAX_CHUNK;     // Adaptive: shrinks to fit the provider, then stays shrunk for the rest of this scan.
    let start = from;
    let transientRetries = 0;

    while (start <= to) {
      const end = Math.min(start + chunk - 1, to);

      try {
        const events = await contract.queryFilter(filter, start, end);
        allEvents.push(...events);
        transientRetries = 0;
        if (events.length > 0) {
          console.log(`[connector:${this.chain}] Found ${events.length} events in blocks ${start}-${end}`);
        }
        start = end + 1;
        if (start <= to) await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        // BAD_DATA with value "0x" is the provider saying "no logs here" — not
        // an error. Advance past it.
        if (error.code === 'BAD_DATA') { start = end + 1; transientRetries = 0; continue; }

        // Range/response too large → shrink and retry the SAME window. This is
        // the real fit: keep halving until the provider accepts it.
        if (this._isRangeLimitError(error)) {
          if (chunk > MIN_CHUNK) {
            chunk = Math.max(MIN_CHUNK, chunk >> 1);
            console.warn(`[connector:${this.chain}] range refused at ${start}-${end}; shrinking chunk to ${chunk} and retrying`);
            continue;   // same start, smaller end
          }
          // Refused even at the floor → this provider won't serve getLogs
          // (e.g. a free tier). Hard stop: trip the breaker and fail loud.
          this._tripBreaker(bkey, error, `${start}-${end}`);
          throw new Error(`[connector:${this.chain}] event scan blocked at blocks ${start}-${end} — provider refuses getLogs even at ${MIN_CHUNK}-block ranges: ${error.message}`);
        }

        // Otherwise a transient failure (network / 5xx). Bounded backoff-retry
        // of the same chunk; give up loud after the budget so we never advance
        // past an unread window.
        transientRetries++;
        if (transientRetries > MAX_TRANSIENT_RETRIES) {
          this._tripBreaker(bkey, error, `${start}-${end}`);
          throw new Error(`[connector:${this.chain}] event scan failed at blocks ${start}-${end} after ${MAX_TRANSIENT_RETRIES} retries: ${error.message}`);
        }
        const backoff = Math.min(10000, 1000 * Math.pow(2, transientRetries - 1));
        console.error(`[connector:${this.chain}] transient error at blocks ${start}-${end} (retry ${transientRetries}/${MAX_TRANSIENT_RETRIES}): ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    // Clean scan of the whole window — clear any prior breaker state so a
    // recovered provider (or the new owned node) resumes at full speed.
    this._scanBreaker.delete(bkey);
    return allEvents.map(event => this.normalizeEvent(event));
  }

  _breakerKey(address, eventFilter) {
    return `${this.chain}:${address}:${eventFilter}`.toLowerCase();
  }

  // A "the range/response is too big" or "getLogs not allowed here" signal from
  // any provider. Matched broadly across message, JSON-RPC error and the nested
  // provider body (drpc: `code:35 "ranges over 10000 blocks..."`; others use
  // -32005 / "query returned more than N results" / "response size exceeded").
  _isRangeLimitError(error) {
    const hay = [
      error?.message,
      error?.error?.message,
      error?.shortMessage,
      (() => { try { return JSON.stringify(error?.info); } catch { return ''; } })(),
    ].join(' ').toLowerCase();
    return /over \d+ blocks|block range|range is too|too many blocks|response size|result set too large|returned more than|query timeout|limit exceeded|exceeds? the limit|"code":\s*35|-32005/.test(hay);
  }

  _tripBreaker(key, error, window) {
    const prev = this._scanBreaker.get(key);
    const failures = (prev?.failures || 0) + 1;
    // Exponential cool-down, capped: 30s, 60s, 120s … up to 15 min. Long enough
    // that a persistently-broken RPC costs a couple of calls per cool-down (not
    // a flood), short enough to recover promptly once the RPC/node is fixed.
    const cool = Math.min(15 * 60 * 1000, 30 * 1000 * Math.pow(2, Math.min(failures - 1, 5)));
    this._scanBreaker.set(key, { failures, openUntil: Date.now() + cool });
    console.error(`[connector:${this.chain}] scan circuit OPEN for blocks ${window} after ${failures} failure(s) — cooling down ${Math.round(cool / 1000)}s. Underlying: ${error.message}`);
  }

  /**
   * Normalize event to standard format
   */
  normalizeEvent(event) {
    // In ethers v6, event name is in event.fragment.name or event.eventName
    const eventName = event.eventName || event.fragment?.name || event.event || 'Unknown';

    // Extract args - in ethers v6, args is an array-like object
    // We need to convert it to a plain object with named parameters
    const args = {};
    if (event.args) {
      // Get fragment to access parameter names
      const fragment = event.fragment;
      if (fragment && fragment.inputs) {
        fragment.inputs.forEach((input, index) => {
          args[input.name] = event.args[index];
        });
      }
    }

    return {
      chain: this.chain,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      address: event.address,
      event: eventName,
      args: args,
      timestamp: null // Will be enriched with block timestamp
    };
  }

  /**
   * Get block timestamp
   */
  async getBlockTimestamp(blockNumber) {
    const block = await this.provider.getBlock(blockNumber);
    return new Date(block.timestamp * 1000);
  }

  /**
   * Read contract data
   */
  async readContract(address, abi, method, args = []) {
    const contract = new ethers.Contract(address, abi, this.provider);
    return await contract[method](...args);
  }

  /**
   * Get transaction details
   */
  async getTransaction(hash) {
    return await this.provider.getTransaction(hash);
  }

  /**
   * Get transaction receipt
   */
  async getTransactionReceipt(hash) {
    return await this.provider.getTransactionReceipt(hash);
  }

  /**
   * Get full transaction details (transaction + receipt + block)
   */
  async getTransactionDetails(hash) {
    const [tx, receipt] = await Promise.all([
      this.getTransaction(hash),
      this.getTransactionReceipt(hash)
    ]);

    if (!tx) {
      return null;
    }

    const block = await this.provider.getBlock(tx.blockNumber);

    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: tx.value.toString(),
      gasLimit: tx.gasLimit.toString(),
      gasPrice: tx.gasPrice?.toString(),
      maxFeePerGas: tx.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
      nonce: tx.nonce,
      data: tx.data,
      blockNumber: tx.blockNumber,
      blockHash: tx.blockHash,
      timestamp: block.timestamp,
      gasUsed: receipt?.gasUsed?.toString(),
      status: receipt?.status,
      contractAddress: receipt?.contractAddress,
      logs: receipt?.logs || []
    };
  }
}

/**
 * ChainConnectorFactory
 *
 * Creates connectors for different chains
 */
export class ChainConnectorFactory {
  static async create(chain, rpcUrl, chainId) {
    const connector = new ChainConnector({ chain, rpcUrl, chainId });
    await connector.connect();
    return connector;
  }

  /**
   * Create connectors from config
   */
  static async createFromConfig(config) {
    const connectors = {};
    const chains = Object.entries(config.chains || {});

    for (let i = 0; i < chains.length; i++) {
      const [chain, chainConfig] = chains[i];
      if (chainConfig.enabled !== false) {
        connectors[chain] = await ChainConnectorFactory.create(chain, chainConfig.rpcUrl, chainConfig.chainId);

        // Add delay between connector initializations to avoid rate limiting
        if (i < chains.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    return connectors;
  }
}
