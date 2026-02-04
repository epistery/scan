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
    this.provider = null;
  }

  /**
   * Connect to the blockchain
   */
  async connect() {
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
    const network = await this.provider.getNetwork();
    console.log(`[connector] Connected to ${this.chain} (chainId: ${network.chainId})`);
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
   * Query events from a contract
   * Chunks large block ranges to avoid RPC timeouts
   */
  async queryEvents(address, eventFilter, fromBlock, toBlock) {
    const contract = new ethers.Contract(address, ['event ' + eventFilter], this.provider);
    const filter = contract.filters[eventFilter.split('(')[0]]();

    // Use very small chunk size for polygon due to Infura's strict limits
    // Polygon seems to have undocumented strict limits, use 1 block at a time
    const chunkSize = this.chain === 'polygon' ? 1 : 2000;
    const from = fromBlock || 0;
    const to = toBlock || await this.getCurrentBlock();

    const allEvents = [];
    let consecutiveErrors = 0;

    for (let start = from; start <= to; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, to);

      try {
        const events = await contract.queryFilter(filter, start, end);
        allEvents.push(...events);
        consecutiveErrors = 0; // Reset error counter on success

        if (events.length > 0) {
          console.log(`[connector:${this.chain}] Found ${events.length} events in blocks ${start}-${end}`);
        }

        // Add delay between chunk requests (slower for polygon)
        if (start + chunkSize <= to) {
          const delay = this.chain === 'polygon' ? 500 : 300;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        console.error(`[connector:${this.chain}] Error querying blocks ${start}-${end}:`, error.message);
        consecutiveErrors++;

        // If too many consecutive errors, give up on this event type
        if (consecutiveErrors >= 5) {
          console.error(`[connector:${this.chain}] Too many consecutive errors, skipping remaining blocks for this event`);
          break;
        }

        // Exponential backoff based on error count
        const backoff = Math.min(10000, 1000 * Math.pow(2, consecutiveErrors - 1));
        console.log(`[connector:${this.chain}] Backing off, waiting ${backoff}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    return allEvents.map(event => this.normalizeEvent(event));
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
  static async create(chain, rpcUrl) {
    const connector = new ChainConnector({ chain, rpcUrl });
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
        connectors[chain] = await ChainConnectorFactory.create(chain, chainConfig.rpcUrl);

        // Add delay between connector initializations to avoid rate limiting
        if (i < chains.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    return connectors;
  }
}
