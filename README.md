# epistery-scan

Epistery Scan is a blockchain explorer for the Epistery ecosystem - chain-first, not chain-specific.

**Live at:** https://epistery.io

## Philosophy: Chain-First Architecture

Unlike traditional blockchain explorers that cache everything, Epistery Scan treats **the blockchain as the source of truth**:

- **Search queries the chain directly** - Real-time contract state, no stale data
- **Events fetched on-demand** - Read from chain when viewing a contract
- **Transactions live-queried** - No storage, just direct RPC calls
- **MongoDB is only an index** - Maps addresses to chains for faster lookups

This approach:
- Eliminates data synchronization issues
- Reduces database storage by 95%
- Makes efficient use of RPC quota (15M requests available)
- Ensures data is always current

## What It Does

Epistery Scan understands Epistery contracts and presents blockchain data meaningfully:

**For addresses:**
- Detects if it's a contract or wallet
- Reads epistery attributes (owner, sponsor, domain, version)
- Shows human-readable event interpretations
- Reconstructs current state (ACLs, attributes) from event history

**For events:**
- Interprets `agent.ACLModified` as "**0xc191...** added `0xB357...` to `epistery::editor`"
- Shows `agent.AttributeSet` as "**0xc191...** set 🔓 public attribute `@epistery/wiki`"
- Displays reconstructed object state (current ACL members, active attributes)

**For contracts:**
- Agent.sol - Domain hosts managing access lists
- IdentityContract.sol - Multi-device identity binding
- CampaignWallet.sol - Ad campaign management

## Architecture

### Chain Connectors
Normalize blockchain access across different chains:
- Ethereum mainnet
- Polygon mainnet
- Polygon Amoy testnet
- Configurable RPC endpoints via epistery config

### Event Interpreters
Parse raw logs into meaningful events:
- `AgentInterpreter` - Handles Agent.sol events (ACLModified, AttributeSet, AttributeDeleted, OwnershipTransferred)
- Gracefully handles contracts without `domain()` (not all contracts are DomainAgents)
- Extensible for IdentityContract and CampaignWallet

### Database (MongoDB)
**Minimal storage philosophy:**
- `entities` - Address→chain index with basic metadata
- `monitors` - Contracts to track (manual additions only, no auto-polling)
- Events cached temporarily but always re-fetched from chain

### API Handlers
- **Search** - Chain-first lookup with fallback to index
- **Fetch** - On-demand event/transaction fetching
- **Monitor** - Manual contract tracking (no auto-polling)
- **Events** - Hybrid cache/chain event retrieval

### SSL & Deployment
- Automatic SSL via `@metric-im/administrate`
- Let's Encrypt certificates auto-provision and renew
- No nginx needed - handles HTTP (port 80) and HTTPS (port 443) directly

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure database (secrets.json)
```json
{
  "contactEmail": "your@email.com",
  "mongo": {
    "host": "192.168.1.100",
    "host_dev": "1.2.3.4",
    "port": 27017,
    "database": "epistery-scan",
    "username": "epistery_user",
    "password": "your_password"
  }
}
```

**Environment modes:**
- `PROFILE=PROD` (default) - Uses `mongo.host` (LAN IP)
- `PROFILE=DEV` - Uses `mongo.host_dev` (public IP for whitelisted machines)

**Important:** Connection string must include `directConnection=true` to prevent MongoDB driver from hanging on replica set discovery.

### 3. Configure chains (~/.epistery/config.ini)
```ini
[chains.polygon]
enabled=true
rpcUrl=https://polygon-mainnet.infura.io/v3/YOUR_API_KEY

[chains.ethereum]
enabled=false
rpcUrl=https://mainnet.infura.io/v3/YOUR_API_KEY

[chains.polygon-amoy]
enabled=true
rpcUrl=https://polygon-amoy.infura.io/v3/YOUR_API_KEY

[ingestion]
autostart=false
```

**Note:** Auto-polling is disabled by default. Use on-demand fetching to control RPC usage.

### 4. Run locally (development)
```bash
PROFILE=DEV npm start
```

Server runs on:
- HTTP: port 80 (configurable via `PORT` env var)
- HTTPS: port 443 (configurable via `PORTSSL` env var)

### 5. Deploy to production
```bash
# On epistery.io server
git pull
npm install
sudo systemctl restart epistery-scan
```

SSL certificates provision automatically via administrate.

## Usage

### Web Interface

**Search:** https://epistery.io

Enter:
- Contract address: `0x330fE90a198283803B78c02BfFa5390Ec2f15d70`
- Wallet address: `0xc191714b9c925063e4782691C36b8ff0605f6a6B`
- Transaction hash: `0xbea85b7f...` (64 hex chars)
- Domain name: Search indexed contracts by domain

**Results show:**
- **Overview** - Contract type, chain, owner, domain, version
- **Events** - Human-readable event interpretations
- **Transactions** - Full transaction details from chain
- **Object Data** - Reconstructed current state (ACLs, attributes)

### API Endpoints

**Chain-First Search**
```bash
# Search (queries chain directly)
GET /api/search?q=0x330fE90a198283803B78c02BfFa5390Ec2f15d70&chain=polygon-amoy

# Get address details (reads contract state from chain)
GET /api/search/address/0x330fE90a198283803B78c02BfFa5390Ec2f15d70?chain=polygon-amoy

# Get events (hybrid: cached or chain-fetched)
GET /api/search/events/0x330fE90a198283803B78c02BfFa5390Ec2f15d70?chain=polygon-amoy&limit=200

# Get transaction details (fetched from chain)
GET /api/search/tx/0xbea85b7f...?chain=polygon-amoy
```

**On-Demand Fetching**
```bash
# Fetch events for specific block range
POST /api/fetch/events
{
  "address": "0x330fE90a198283803B78c02BfFa5390Ec2f15d70",
  "chain": "polygon-amoy",
  "fromBlock": 33000000,
  "toBlock": 33100000
}

# Fetch transaction details
POST /api/fetch/transaction
{
  "hash": "0xbea85b7f...",
  "chain": "polygon-amoy"
}

# Get current block number
GET /api/fetch/block-number?chain=polygon-amoy
```

**Manual Monitoring**
```bash
# Add contract to index
POST /api/monitor
{
  "address": "0x330fE90a198283803B78c02BfFa5390Ec2f15d70",
  "chain": "polygon-amoy",
  "type": "Agent"
}

# List monitors
GET /api/monitor

# Remove monitor
DELETE /api/monitor/0x330fE90a198283803B78c02BfFa5390Ec2f15d70?chain=polygon-amoy
```

## Event Interpretation

Epistery Scan understands Epistery contract events:

**agent.ACLModified**
```
Raw: { owner: "0xc191...", addr: "0xB357...", listName: "epistery::editor", action: "add" }
Displayed: "0xc191... added 0xB357... to epistery::editor"
```

**agent.AttributeSet**
```
Raw: { owner: "0xc191...", key: "@epistery/wiki", isPrivate: false }
Displayed: "0xc191... set 🔓 public attribute @epistery/wiki"
```

**agent.AttributeDeleted**
```
Raw: { owner: "0xc191...", key: "@epistery/wiki" }
Displayed: "0xc191... deleted attribute @epistery/wiki"
```

**agent.OwnershipTransferred**
```
Raw: { previousOwner: "0xc191...", newOwner: "0xe75F..." }
Displayed: "Ownership transferred from 0xc191... to 0xe75F..."
```

## State Reconstruction

The **Object Data** tab reconstructs current contract state by replaying events chronologically:

**Access Control Lists:**
- Tracks `add`/`remove` actions per list
- Shows current members with dates added
- Groups by list name (epistery::admin, epistery::editor, etc.)

**Attributes:**
- Tracks `set`/`delete` operations
- Shows privacy status (🔒 private / 🔓 public)
- Displays last modified timestamp

**Ownership:**
- Tracks OwnershipTransferred events
- Shows current owner

All state is computed live from events - no separate state storage.

## Development

**Code Style:**
- Raw JavaScript (no React/Vue/Angular)
- ES modules
- Minimal abstractions
- Chain-first queries
- MongoDB for indexing only

**Key Files:**
- `index.mjs` - Server setup with administrate SSL
- `handlers/Search.mjs` - Chain-first search implementation
- `handlers/Fetch.mjs` - On-demand data fetching
- `ingestion/ChainConnector.mjs` - Blockchain RPC interface
- `ingestion/interpreters/AgentInterpreter.mjs` - Agent.sol event parsing
- `db/Database.mjs` - Minimal MongoDB operations
- `public/index.html` - Single-file UI with event interpretation

**Testing queries:**
```bash
# Local testing
mongosh "mongodb://username:password@host:port/database?authSource=admin&directConnection=true"

# Check connection from app
curl http://localhost/health
```

## Reference

**Core Epistery:**
- `/rootz/epistery` - Core epistery module
- `/rootz/epistery/contracts/Agent.sol` - Agent contract source
- `https://wiki.rootz.global` - Epistery documentation

**Related Projects:**
- `/epistery/epistery-host` - Domain host implementation (uses administrate)
- `/epistery/wiki` - Wiki agent (reference for epistery integration)
- `/geistm/adnet-agent` - Adnet agent implementation
- `/metric-im/componentry` - UI component framework
- `/metric-im/administrate` - Automatic SSL provisioning

**Examples:**
- `epistery curl https://wiki.rootz.global/wiki/Home` - Access epistery wiki
- Search `0x330fE90a198283803B78c02BfFa5390Ec2f15d70` on epistery.io
- View wallet `0xc191714b9c925063e4782691C36b8ff0605f6a6B` activity

## License

UNLICENSED - Proprietary
