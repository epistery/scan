/**
 * Block-explorer address pages, per chain slug. A contract-backed entity's
 * locator is the chain itself — scan's stored figures are a cache; the
 * explorer URL is where anyone re-reads the origin.
 */
const EXPLORERS = {
  polygon: 'https://polygonscan.com/address/',
  'polygon-amoy': 'https://amoy.polygonscan.com/address/',
  ethereum: 'https://etherscan.io/address/',
  sepolia: 'https://sepolia.etherscan.io/address/',
  japanopenchain: 'https://explorer.japanopenchain.org/address/'
};

export function explorerUrl(chain, address) {
  return EXPLORERS[chain] ? `${EXPLORERS[chain]}${address}` : null;
}

/** 0x1234…cdef — display form of an address for card facets. */
export function shortAddress(addr) {
  if (!addr || typeof addr !== 'string' || addr.length < 12) return addr || null;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
