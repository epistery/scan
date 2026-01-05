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
   */
  async queryEvents(address, eventFilter, fromBlock, toBlock) {
    const contract = new ethers.Contract(address, ['event ' + eventFilter], this.provider);
    const filter = contract.filters[eventFilter.split('(')[0]]();

    const events = await contract.queryFilter(
      filter,
      fromBlock || 0,
      toBlock || 'latest'
    );

    return events.map(event => this.normalizeEvent(event));
  }

  /**
   * Normalize event to standard format
   */
  normalizeEvent(event) {
    return {
      chain: this.chain,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      address: event.address,
      event: event.event,
      args: event.args ? Object.fromEntries(
        Object.entries(event.args).filter(([key]) => isNaN(key))
      ) : {},
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

    for (const [chain, chainConfig] of Object.entries(config.chains || {})) {
      if (chainConfig.enabled !== false) {
        connectors[chain] = await ChainConnectorFactory.create(chain, chainConfig.rpcUrl);
      }
    }

    return connectors;
  }
}
