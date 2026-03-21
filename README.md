# Epistery Scan

Cross-chain blockchain explorer and AI discovery indexer for the Epistery ecosystem.

**Live at:** https://epistery.io

Epistery Scan indexes two kinds of entities through a unified architecture:

- **Blockchain contracts** on Ethereum and Polygon (Agents, Identity Contracts, Campaign Wallets)
- **AI Discovery manifests** published at `/.well-known/ai` per the [Rootz AI Discovery Standard](https://rootz.global/ai/standard.md)

Both are treated as first-class entities. A domain publishing a signed manifest is architecturally equivalent to a blockchain contract -- DNS is the trust substrate instead of a chain.

## Architecture

```
index.mjs                         Express server, SSL, route mounting
  |
  +-- db/Database.mjs             MongoDB layer (entities, events, monitors, domains, transactions)
  |
  +-- ingestion/
  |     IngestionManager.mjs      Coordinates polling across chains and web discovery
  |     EntityTypeRegistry.mjs    Maps type names to interpreters with source metadata
  |     ChainConnector.mjs        Normalized blockchain RPC access (ethers v6)
  |     DomainDiscovery.mjs       Crawls domains for /.well-known/ai manifests
  |     |
  |     +-- interpreters/
  |           AgentInterpreter.mjs              Agent.sol -- domain hosts, ACLs, attributes
  |           IdentityContractInterpreter.mjs   IdentityContract.sol -- multi-sig rivets
  |           CampaignWalletInterpreter.mjs     CampaignWallet.sol -- ad campaigns, payouts
  |           AIDiscoveryInterpreter.mjs        Web manifests via DomainDiscovery
  |
  +-- handlers/
  |     Search.mjs                Chain-first search (address, tx hash, text/domain)
  |     Monitor.mjs               Add/remove monitored addresses
  |     Event.mjs                 Query, aggregate, timeline events
  |     Fetch.mjs                 On-demand data fetching
  |     Discovery.mjs             Domain submission and listing API
  |
  +-- public/
        index.html                Main search UI with type-aware rendering
        discovery.html            AI Discovery browser
```

### Entity Type Registry

All entity types register through `EntityTypeRegistry` with a unified interpreter interface:

```
registry.register(typeName, interpreter, { source: 'blockchain' | 'web' })

Interpreter interface:
  sync(address, chain)                    Fetch current state, store entity
  processEvents(address, chain, from, to) Ingest new events (no-op for web entities)
  getSummary(address, chain)              Structured summary
  getSchema()                             { source, tabs[] } -- rendering hints for UI
```

Registered types:

| Type | Source | Interpreter | Description |
|------|--------|-------------|-------------|
| Agent | blockchain | AgentInterpreter | Agent.sol -- domain hosts with ACLs and key-value attributes |
| IdentityContract | blockchain | IdentityContractInterpreter | IdentityContract.sol -- multi-sig identity binding via rivets |
| CampaignWallet | blockchain | CampaignWalletInterpreter | CampaignWallet.sol -- ad campaign budgets and publisher payouts |
| AIDiscovery | web | AIDiscoveryInterpreter | `/.well-known/ai` manifests fetched via DomainDiscovery |

### Ingestion

**Blockchain polling**: `IngestionManager` polls monitored addresses on a configurable interval (default 5 min). For each monitor it calls `interpreter.processEvents()` then `interpreter.sync()`.

**Domain discovery**: `DomainDiscovery` runs on a separate 24-hour cycle. It seeds known domains, discovers new domains from Agent contract metadata and manifest partner links, then calls `syncDomain()` to fetch and verify each manifest. `AIDiscoveryInterpreter` wraps this via composition, exposing `domainDiscovery` for crawl-specific methods while implementing the standard interpreter interface.

**DomainDiscovery internals:**
- `syncDomain(domain)` -- the interpreter-compatible core: fetch manifest, verify signature, fetch tiers, store entity, record event. Returns `{ entity, manifest }` or null.
- `checkDomain(domain)` -- crawl wrapper around `syncDomain`: manages crawl state (`lastChecked`, `nextCheck`, `status`) and triggers domain discovery from manifest links.
- `seedKnownDomains()`, `discoverFromAgents()`, `discoverDomains()` -- populate the domain crawl queue.

### Chain Connector

`ChainConnector` normalizes RPC access across chains using ethers v6. Handles chunked event queries with exponential backoff for rate-limited providers (especially Polygon/Infura).

### Database (MongoDB)

| Collection | Purpose |
|-----------|---------|
| `entities` | All indexed entities keyed by address (unique). Stores type, chain, metadata, timestamps. |
| `events` | Loosely typed event log. Blockchain events and discovery events both land here. |
| `monitors` | Addresses being actively polled. Tracks chain, type, active status. |
| `domains` | AI Discovery crawl state. Tracks check schedule, discovery source, status. |
| `transactions` | Cached transaction details fetched from chain. |

## API

All endpoints return JSON. No authentication required for read operations.

### Search (chain-first)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search?q={query}` | GET | Search by address (0x...), tx hash, or text/domain |
| `/api/search/address/:address?chain=` | GET | Contract or wallet details from chain |
| `/api/search/tx/:hash?chain=` | GET | Transaction details from chain |
| `/api/search/events/:address?chain=` | GET | On-chain event log for an address |

Text/domain queries search MongoDB. Address and tx queries go to the chain directly. Domain-like queries trigger on-demand discovery if the domain isn't already indexed. Search results include `schema` from the registry so the UI knows how to render each entity type.

### Monitors

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/monitor` | GET | List active monitors |
| `/api/monitor` | POST | Add monitor `{ address, chain, type }` -- type validated against registry |
| `/api/monitor/:address` | GET | Monitor status with entity and event count |
| `/api/monitor/:address` | DELETE | Remove monitor |

### Events

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/events?entityId=&type=&chain=&from=&to=` | GET | Query event log with filters |
| `/api/events/stats?entityId=&chain=` | GET | Event type counts and date ranges |
| `/api/events/timeline?interval=day` | GET | Event counts by time bucket |
| `/api/events/aggregate` | POST | Raw MongoDB aggregation pipeline |

### AI Discovery

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/discovery` | GET | List indexed AI Discovery domains |
| `/api/discovery/:domain` | GET | Full manifest and crawl state for a domain |
| `/api/discovery` | POST | Submit domain for indexing `{ domain }` |
| `/api/discovery/check` | POST | Force re-check `{ domain }` |

### Fetch (on-demand)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fetch/events` | POST | Fetch events for specific block range |
| `/api/fetch/transaction` | POST | Fetch and cache transaction details |
| `/api/fetch/block-number?chain=` | GET | Current block number for a chain |

### Other

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/ai` | GET | This server's own AI Discovery manifest |
| `/health` | GET | Health check with DB and ingestion status |

## UI

The main search page (`/`) renders results with **type-aware tabs** driven by `getSchema()`:

**Blockchain entities** (Agent, IdentityContract, CampaignWallet) -- tabs: Overview, Transactions, Events, Object Data

- Events tab parses raw blockchain logs into human-readable descriptions (e.g. "0xc191... added 0xB357... to epistery::editor")
- Object Data reconstructs current state by replaying events chronologically:
  - ACL membership per list, with add dates
  - Active attributes with privacy status
  - Current owner from OwnershipTransferred events
  - Campaign financials (budget, payouts, withdrawals), promotion status

**AI Discovery entities** -- tabs: Overview, Pages, APIs, Policies, Concepts, Raw JSON

- **Overview** -- domain link with verification badge (Verified/Signed/Unsigned), organization table, capabilities table, stats, AI instructions, rate limits, contact info
- **Pages** -- site map from `manifest.pages[]` with path (linked), title, purpose, concept tags
- **APIs** -- endpoint table from `manifest.apis` with name, URL, method, description
- **Policies** -- content license (type + restrictions), privacy policy link, details URL from `manifest.policies`
- **Concepts** -- glossary from `manifest.coreConcepts[]` with term and definition
- **Raw JSON** -- formatted manifest source

The AI Discovery browser (`/discovery`) provides a dedicated view of all indexed domains.

## Event Interpretation

Epistery Scan understands these event types:

**Agent events:** ACLModified, AttributeSet, AttributeDeleted, OwnershipTransferred, ApprovalRequested, ApprovalHandled

**Identity events:** RivetAdded, RivetRemoved, ThresholdChanged

**Campaign events (v2):** BatchSubmitted, Withdrawn, PromotionAdded, PromotionUpdated, CampaignPaused, CampaignUnpaused, BudgetAdded

**System events:** OwnershipTransferred (OpenZeppelin), RoleGranted, RoleRevoked

**Discovery events:** discovery.indexed, discovery.updated, discovery.error

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
- `PROFILE=PROD` (default) -- uses `mongo.host` (LAN IP)
- `PROFILE=DEV` -- uses `mongo.host_dev` (public IP for whitelisted machines)

Connection string includes `directConnection=true` to prevent MongoDB driver from hanging on replica set discovery.

Falls back to `mongodb://localhost:27017/epistery-scan` if no secrets file.

### 3. Configure chains (~/.epistery/config)
```ini
[chains.polygon]
enabled=true
rpcUrl=https://polygon-mainnet.infura.io/v3/YOUR_API_KEY

[chains.ethereum]
enabled=true
rpcUrl=https://mainnet.infura.io/v3/YOUR_API_KEY

pollInterval = 300000
discoveryPollInterval = 86400000

[ingestion]
autostart=true
```

### 4. Run
```bash
npm start                  # Production (HTTP :80, HTTPS :443)
PROFILE=DEV npm start      # Development (uses dev mongo host)
```

SSL certificates provision automatically via `@metric-im/administrate`.

## Tech Stack

- Node.js, ES modules (`.mjs`)
- Express 4
- MongoDB 4
- ethers v6 for blockchain RPC
- Vanilla HTML/CSS/JS (no frameworks)
- `epistery` for config and key management
- `@metric-im/administrate` for automatic SSL
- `@metric-im/componentry` for ID generation

## Key Files

| File | Purpose |
|------|---------|
| `index.mjs` | Server setup, route mounting, SSL |
| `db/Database.mjs` | All MongoDB operations |
| `ingestion/EntityTypeRegistry.mjs` | Type-to-interpreter mapping |
| `ingestion/IngestionManager.mjs` | Poll coordination, registry wiring |
| `ingestion/ChainConnector.mjs` | Blockchain RPC interface |
| `ingestion/DomainDiscovery.mjs` | Domain crawling and manifest verification |
| `ingestion/interpreters/*.mjs` | One interpreter per entity type |
| `handlers/Search.mjs` | Chain-first search with text fallback |
| `handlers/Monitor.mjs` | Monitor CRUD, type validation against registry |
| `handlers/Event.mjs` | Event queries, aggregation, timeline |
| `handlers/Discovery.mjs` | Domain submission and listing |
| `handlers/Fetch.mjs` | On-demand chain data fetching |
| `public/index.html` | Search UI with type-aware tab rendering |
| `public/discovery.html` | AI Discovery browser |

## Reference

- [AI Discovery Standard](https://rootz.global/ai/standard.md) -- the `/.well-known/ai` specification
- [Epistery Wiki](https://wiki.rootz.global) -- ecosystem documentation
- `/rootz/epistery` -- core epistery module
- `/rootz/epistery/contracts/Agent.sol` -- Agent contract source
- `/epistery/epistery-host` -- hosted epistery for domain owners
- `/geistm/adnet-agent` -- Adnet agent implementation
- `/geistm/adnet-factory-v2` -- CampaignWallet v2 contracts
- `/metric-im/componentry` -- client-side modularity
- `/metric-im/wiki-mixin` -- wiki reference implementation

## License

UNLICENSED - Proprietary
