# Epistery Scan

Search the signed web. Cross-chain blockchain explorer, AI discovery indexer, and multisite host for the Epistery ecosystem.

**Live at:** https://epistery.io

Epistery Scan indexes three kinds of entities through a unified architecture:

- **Blockchain contracts** on Ethereum and Polygon (Agents, Identity Contracts, Campaign Wallets)
- **AI Discovery manifests** published at `/.well-known/ai` per the [Rootz AI Discovery Standard](https://rootz.global/ai/standard.md)
- **MCP services** via federated search to [mcp-registry](https://mcp.epistery.io) (6,000+ services with live tool schemas)

Both domain manifests and blockchain contracts are first-class entities. A domain publishing a signed manifest is architecturally equivalent to a blockchain contract -- DNS is the trust substrate instead of a chain.

Scan also acts as a **multisite host**: it owns ports 80/443, provisions TLS via Certify, and spawns child services (like mcp-registry) through the Harness. Incoming requests are routed by hostname -- `epistery.io` hits scan, `mcp.epistery.io` is proxied to the child.

## Architecture

```
index.mjs                         Express server, TLS, Harness, route mounting
  |
  +-- lib/Harness.mjs             Child process manager — spawns, health-checks,
  |                                proxies, and provides query/post fan-out
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
  |     Search.mjs                Federated search — signed-web + harness children + @delegation
  |     Monitor.mjs               Add/remove monitored addresses
  |     Event.mjs                 Query, aggregate, timeline events
  |     Fetch.mjs                 On-demand data fetching
  |     Discovery.mjs             Domain submission and listing API
  |     Feed.mjs                  Activity feed
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

### Harness (Multisite Host)

`Harness` manages child processes that serve hostname-routed traffic. Configured in `~/.epistery/config.ini`:

```ini
[harness]
mcp.epistery.io=/home/.../mcp-registry
```

Each child is spawned with `UPSTREAM=1` and a sequential port starting at 53900. The harness:

- **Proxies** — incoming requests matching a child's hostname are forwarded transparently (middleware)
- **Health-checks** — polls `/health` every 30s, marks children healthy/unhealthy
- **Fan-out GET** — `harness.query(path)` sends a GET to all healthy children in parallel, merges results
- **Targeted POST** — `harness.post(hostname, path, body)` sends a POST to a specific child (used for MCP delegation)
- **Graceful shutdown** — SIGTERM with 5s timeout, then SIGKILL

### Federated Search

`Search.mjs` combines multiple data sources in a single query:

1. **Signed web** — MongoDB full-text search across indexed `/.well-known/ai` manifests
2. **Blockchain** — direct chain lookup for `0x...` addresses
3. **Harness children** — fan-out GET to mcp-registry and future children, results merged and normalized
4. **`@service` delegation** — queries starting with `@service-name` are routed to a live MCP endpoint:
   - Calls mcp-registry's `/api/service/:name/tools` to get the live tool catalog
   - Picks the best-matching tool via keyword scoring
   - Calls `/api/service/:name/call` with the tool and query arguments
   - Returns structured results with delegation metadata

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

### Search (federated)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search?q={query}` | GET | Federated search: signed-web + harness children + @delegation |
| `/api/search/entity/:id` | GET | Full details for a specific domain or address |
| `/api/search/stats` | GET | Index statistics |
| `/api/search/submit` | POST | Submit domain for indexing `{ domain }` |

Query types:
- **`0x...` address** — direct blockchain lookup
- **`domain.name`** — direct MongoDB lookup, triggers discovery if unknown
- **`keyword`** — full-text search across signed-web manifests + fan-out to mcp-registry
- **`@service-name query`** — explicit delegation to a live MCP service endpoint

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

### 2. Configure root `~/.epistery/config.ini`

All configuration via epistery Config module — no `.env` files, no `secrets.json`.

```ini
[profile]
email=your@email.com            # present = HTTPS via Certify; omit = dev HTTP

[mongo]
host=10.0.0.112
port=27017
database=epistery-scan
username=epistery_user
password=your_password

[harness]
mcp.epistery.io=/opt/mcp-registry

[ingestion]
autostart=false
```

**MongoDB**: Connection from `[mongo]` section. Uses `directConnection=true` to prevent replica set discovery hangs. Falls back to `mongodb://localhost:27017/epistery-scan` if unconfigured.

**Harness**: Maps hostnames to child service directories. Each child must have `src/server.js`. Leave empty for standalone operation.

**Important — the harness key is the service's canonical hostname, not a routing alias.** `handlers/McpProxy.mjs` hardcodes `MCP_HOST = 'mcp.epistery.io'` and matches child responses by that exact hostname. Using `mcp.localhost` or similar will spawn the child and pass health checks, but the UI will report *"MCP Registry unavailable — running in dev mode without harness"*. The hostname is an identity key (see shadow-DNS config below), not just a route.

**Ingestion**: `autostart=false` (default) means no automatic RPC polling. Set `true` on the production host. When disabled, manual ingestion still works via `/api/monitor` and `/api/fetch`.

**Env vars**: Only `PORT` and `PORTSSL` are honored. Everything else — including dev/prod mode — comes from config.ini.

### 3. Per-service (shadow-DNS) configs

Each harness child reads its own scoped config from `~/.epistery/<hostname>/config.ini`. The hostname is an identity key (like a wallet address) — the child code does `config.setPath('/<hostname>')` to find it. Don't rename these for a local environment; they must match the same hostname used in `[harness]`.

Example — `mcp-registry` reads MySQL creds from `~/.epistery/mcp.epistery.io/config.ini`:

```ini
[mysql]
host=127.0.0.1
port=3307
user=admin
password=your_password
database=mcp_registry
```

**External deps** — mcp-registry expects MySQL reachable at the configured host/port. On a workstation without direct LAN access to the DB, tunnel it:
```bash
ssh -L 3307:10.5.0.54:3306 ubuntu@epistery.host -N -f
```

### 4. Run

```bash
npm start                  # Prod mode (when [profile] email is set):
                           #   HTTPS :PORTSSL (default 443) + HTTP :PORT (default 80) via Certify
                           #   Spawns harness children, provisions TLS

npm start                  # Dev mode (when [profile] email is absent):
                           #   Plain HTTP on :PORT (default 3000), no TLS
                           #   Harness children still spawn if [harness] is configured
```

The dev/prod toggle is driven entirely by whether `[profile] email` is set in config.ini. Harness children spawn in both modes whenever `[harness]` is configured. In production, scan **is** the multisite host — it owns :80/:443, provisions TLS via Certify, and spawns child services through its built-in Harness. No external reverse proxy needed.

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
| `index.mjs` | Server setup, TLS, Harness bootstrap, route mounting |
| `lib/Harness.mjs` | Child process manager — spawn, health-check, proxy, query/post |
| `db/Database.mjs` | All MongoDB operations |
| `ingestion/EntityTypeRegistry.mjs` | Type-to-interpreter mapping |
| `ingestion/IngestionManager.mjs` | Poll coordination, registry wiring |
| `ingestion/ChainConnector.mjs` | Blockchain RPC interface |
| `ingestion/DomainDiscovery.mjs` | Domain crawling and manifest verification |
| `ingestion/interpreters/*.mjs` | One interpreter per entity type |
| `handlers/Search.mjs` | Federated search with @service delegation |
| `handlers/Monitor.mjs` | Monitor CRUD, type validation against registry |
| `handlers/Event.mjs` | Event queries, aggregation, timeline |
| `handlers/Discovery.mjs` | Domain submission and listing |
| `handlers/Fetch.mjs` | On-demand chain data fetching |
| `handlers/Feed.mjs` | Activity feed |
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
