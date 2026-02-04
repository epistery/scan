#!/usr/bin/env node
import mongodb from 'mongodb';
import { Config } from 'epistery';
import { ChainConnectorFactory } from '../ingestion/ChainConnector.mjs';
import Database from '../db/Database.mjs';

const config = new Config();
const mongoHost = config.data.mongoHost || 'mongodb://localhost:27017/epistery-scan';

/**
 * Populate transactions from events
 */
async function populateTransactions() {
  console.log(`[populate] Connecting to ${mongoHost}...`);
  const client = await mongodb.MongoClient.connect(mongoHost, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  const db = client.db();

  // Setup connector
  const connector = {
    db,
    idForge: { datedId: () => Math.random().toString(36).substring(2, 15) },
    profile: { mongo: { host: mongoHost } }
  };

  const database = new Database(connector);
  await database.initialize();

  // Initialize chain connectors
  const ingestionConfig = {
    chains: {
      'polygon-amoy': {
        enabled: true,
        rpcUrl: config.data.chains?.['polygon-amoy']?.rpcUrl || 'https://rpc-amoy.polygon.technology'
      }
    }
  };

  const connectors = await ChainConnectorFactory.createFromConfig(ingestionConfig);

  // Get unique transaction hashes from events
  const txHashes = await db.collection('events').distinct('transactionHash');
  console.log(`[populate] Found ${txHashes.length} unique transaction hashes`);

  // Fetch and save transaction details
  let processed = 0;
  for (const hash of txHashes) {
    try {
      // Get the chain from the first event with this hash
      const event = await db.collection('events').findOne({ transactionHash: hash });
      const chain = event.chain;
      const connector = connectors[chain];

      if (!connector) {
        console.log(`[populate] No connector for chain ${chain}, skipping ${hash}`);
        continue;
      }

      // Check if already exists
      const existing = await db.collection('transactions').findOne({ hash });
      if (existing) {
        console.log(`[populate] Transaction ${hash} already exists, skipping`);
        continue;
      }

      console.log(`[populate] Fetching ${hash} on ${chain}...`);
      const txDetails = await connector.getTransactionDetails(hash);

      if (txDetails) {
        await database.saveTransaction(txDetails, chain);
        processed++;
        console.log(`[populate] Saved ${hash} (${processed}/${txHashes.length})`);
      } else {
        console.log(`[populate] Transaction ${hash} not found`);
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.error(`[populate] Error fetching ${hash}:`, error.message);
    }
  }

  console.log(`[populate] Done! Processed ${processed} transactions`);
  process.exit(0);
}

populateTransactions().catch(error => {
  console.error('[populate] Fatal error:', error);
  process.exit(1);
});
