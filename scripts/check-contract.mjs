#!/usr/bin/env node
import { ethers } from 'ethers';

const address = '0x08c2646571642eb5d0ab21204e58817da7dc0628';
const rpcUrl = 'https://rpc-amoy.polygon.technology';

async function checkContract() {
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Check if contract exists
  const code = await provider.getCode(address);
  console.log(`Contract code length: ${code.length}`);

  if (code === '0x') {
    console.log('No contract at this address');
    return;
  }

  console.log('Contract exists!');

  // Try to get recent events
  const currentBlock = await provider.getBlockNumber();
  console.log(`Current block: ${currentBlock}`);

  // Get logs for this address (last 10000 blocks)
  const fromBlock = Math.max(0, currentBlock - 10000);
  console.log(`Checking logs from block ${fromBlock} to ${currentBlock}`);

  const logs = await provider.getLogs({
    address: address,
    fromBlock: fromBlock,
    toBlock: currentBlock
  });

  console.log(`Found ${logs.length} logs`);

  if (logs.length > 0) {
    console.log('\nSample log:');
    console.log(JSON.stringify(logs[0], null, 2));
  }
}

checkContract().catch(console.error);
