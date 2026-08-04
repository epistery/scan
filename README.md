claud# Epistery Scan

Search the signed web. Cross-chain blockchain explorer, AI discovery indexer, and multisite host for the Epistery ecosystem.

**Live at:** https://epistery.com

**What Scan is for** is stated on the [About page](https://epistery.com/about.html) — the goal, in the site's own words, readable by human and bot alike. This README covers the *code*; the deep technical and operational detail lives on the [EpisteryScan wiki page](https://geist.social/wiki/EpisteryScan). Each belongs in one place only.

Epistery Scan indexes four kinds of entities through a unified architecture:

- **Blockchain contracts** on Ethereum and Polygon (Agents, Identity Contracts, Campaign Wallets)
- **AI Discovery manifests** published at `/.well-known/ai` per the [Rootz AI Discovery Standard](https://rootz.global/ai/standard.md)
- **MCP services** via federated search to [mcp-registry](https://mcp.epistery.com) (6,000+ services with live tool schemas)
- **Data source skills** — external sites that publish skill manifests describing callable tools for AI agents

Both domain manifests and blockchain contracts are first-class entities. A domain publishing a signed manifest is architecturally equivalent to a blockchain contract -- DNS is the trust substrate instead of a chain.

Scan is not traditional search. AI agents are the primary consumers. For data source skills, the search pipeline returns **skill orientation** — which skills match a query, what tools they expose, and how to call them — rather than proxied results.

Scan also acts as a **multisite host**: it owns ports 80/443, provisions TLS via Certify, and spawns child services (like mcp-registry) through the Harness. Incoming requests are routed by hostname -- `epistery.com` hits scan, `mcp.epistery.com` is proxied to the child.

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
  |           DataSourceInterpreter.mjs         Configured data source skills
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
| DataSource | config | DataSourceInterpreter | Registered data source skills with callable tools |

### Ingestion

**Blockchain polling**: `IngestionManager` polls monitored addresses on a configurable interval (default 5 min). For each monitor it calls `interpreter.processEvents()` then `interpreter.sync()`.

**Domain discovery**: `DomainDiscovery` runs on a separate 24-hour cycle. It seeds known domains, discovers new domains from Agent contract metadata and manifest partner links, then calls `syncDomain()` to fetch and verify each manifest. `AIDiscoveryInterpreter` wraps this via composition, exposing `domainDiscovery` for crawl-specific methods while implementing the standard interpreter interface.

**DomainDiscovery internals:**
- `syncDomain(domain)` -- the interpreter-compatible core: fetch manifest, verify signature, fetch tiers, store entity, record event. Returns `{ entity, manifest }` or null.
- `checkDomain(domain)` -- crawl wrapper around `syncDomain`: manages crawl state (`lastChecked`, `nextCheck`, `status`) and triggers domain discovery from manifest links.
- `seedKnownDomains()`, `discoverFromAgents()`, `discoverDomains()` -- populate the domain crawl queue.

**Data source skills**: `DomainDiscovery` also manages registered data sources from `[datasources.*]` config sections. On startup, `_loadDataSourcesConfig()` reads each entry's URL, label, and topic keywords. `syncDataSourceSkills()` fetches each source's skill manifest at `/.well-known/ai/skill.json`, caching the full tool definitions. Data source domains are seeded alongside regular domains for trust scoring.

**Signed-object index**: scan is a search engine for *signed objects* — its job is to normalize and index what data sources publish, never lose the source, and present every result true to its object type and the author's intent. `ObjectImporter` drives a per-source *import engine* (`ingestion/sources/<name>.mjs`) that pages the source's catalog and maps each raw object into one normalized, globally-indexable entity:

```
address: "<source>:<objectId>"      // e.g. "vehicles:1HG…" — the source stays in the key
type:    "Object"
metadata.source: { name, label, domain, url, author, trustScore, importedAt }   // provenance, never dropped
metadata.object: { type, title, summary, keywords[] }                            // normalized → text-indexed
metadata.fields: { …raw author object… }                                         // author's intent, verbatim
```

The normalized `object.title/summary/keywords` fields join the `knowledge_search` text index (see `db/Database.mjs`), so one query (`honda`) returns Honda vehicles *and* Rep. Mike Honda across sources at once. Each import engine exports `{ objectType, objectsKey, pageSize, listUrl, total, id, map }`; `engineFor(name)` in `ingestion/sources/index.mjs` binds it to the `[datasources.<name>]` config key. Sources without an engine (e.g. `provenance`/origin is an entity-lookup registry, `shipping` exposes no catalog) are not bulk-indexed.

Import runs periodically while ingestion is active, and can be triggered manually:

```
POST /api/ingest            # import every source with an engine (full catalog)
POST /api/ingest/vehicles   # one source
POST /api/ingest/vehicles?cap=2000   # bound objects per source (controlled first run)
```

Imports run in the background (a full cars index is ~200k objects). **To add a new source**: drop a `<name>.mjs` engine in `ingestion/sources/`, register it in that folder's `index.mjs` under its config key, and add the matching `[datasources.<name>]` section.

### Harness (Multisite Host)

`Harness` manages child processes that serve hostname-routed traffic. Configured in `~/.epistery/config.ini`:

```ini
[harness]
mcp.epistery.com=/home/.../mcp-registry
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
4. **Skill orientation** — registered data source skills are scored against query keywords by topic match. Matching skills return their full tool manifests so AI agents know what to call and how. Optionally pre-fetches initial results from the skill's search tool.
5. **`@service` delegation** — queries starting with `@service-name` are routed to a live MCP endpoint:
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
| `/api/skill/:name/call` | GET | Proxy a tool call to a registered data source skill |

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

**Skill entities** (DataSource) -- tabs: Overview, Tools, Manifest

- **Overview** -- skill name, domain link, trust badge, mission statement, topic tags
- **Tools** -- detailed tool list with method, path, and input schema for each
- **Manifest** -- raw skill manifest JSON

The AI Discovery browser (`/discovery`) provides a dedicated view of all indexed domains.

## Data Source Skill Spec

External sites publish a skill manifest at `/.well-known/ai/skill.json`. The shape follows the epistery agent `epistery.json` pattern with added `mission` and `topics` fields for AI orientation:

```json
{
  "name": "rootz/vehicles",
  "version": "1.0.0",
  "description": "Authoritative vehicle specifications and provenance",
  "mission": "Verified vehicle data from manufacturer and registration sources",
  "topics": ["car", "vehicle", "vin", "automobile", "truck"],
  "tools": [
    {
      "name": "search",
      "description": "Search vehicles by make, model, year, VIN, or free text",
      "method": "GET",
      "path": "/api/query?q={query}",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Free text search" }
        },
        "required": ["query"]
      }
    }
  ]
}
```

When an AI agent queries scan for "vehicle", the search pipeline scores data source topics against the query and returns `Skill`-type results containing the full tool manifest, trust score, and optionally pre-fetched initial results. The AI then knows exactly which tools to call and how.

The skill proxy endpoint (`/api/skill/:name/call?tool=search&query=honda`) routes through scan so responses carry scan's attribution signature.

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
mcp.epistery.com=/opt/mcp-registry

[ingestion]
autostart=false
```

**MongoDB**: Connection from `[mongo]` section. Uses `directConnection=true` to prevent replica set discovery hangs. Falls back to `mongodb://localhost:27017/epistery-scan` if unconfigured.

**Harness**: Maps hostnames to child service directories. Each child must have `src/server.js`. Leave empty for standalone operation.

**Important — the harness key is the service's canonical hostname, not a routing alias.** `handlers/McpProxy.mjs` hardcodes `MCP_HOST = 'mcp.epistery.com'` and matches child responses by that exact hostname. Using `mcp.localhost` or similar will spawn the child and pass health checks, but the UI will report *"MCP Registry unavailable — running in dev mode without harness"*. The hostname is an identity key (see shadow-DNS config below), not just a route.

**Data sources**: Register external data source skills under `[datasources.*]` sections. This is the canonical block for the live `epistery.com` host — the five rootz.global data-gathering sites that feed search:

```ini
[datasources.provenance]
url=https://origin.rootz.global
label=Origin — SEC AI Registry
topics=origin,provenance,sec,filing,company,investor,authenticity,registry

[datasources.vehicles]
url=https://cars.rootz.global
label=Cars Rootz
topics=car,vehicle,vin,automobile,truck,make,model,used

[datasources.politics]
url=https://politics.rootz.global
label=Politics Rootz
topics=politics,politician,election,candidate,congress,senate,government,federal,state,local

[datasources.shipping]
url=https://ship.rootz.global
label=Rootz Shipping Intelligence
topics=ship,shipping,oil,tanker,vessel,sanctions,fleet,cargo,maritime,trade

[datasources.rentals]
url=https://rental.rootz.global
label=Rental Rootz Global
topics=rental,vacation,property,caribbean,booking,availability,lease,accommodation
```

Each entry has a name (the INI key), a base URL, a human label, and comma-separated topic keywords for query routing. On startup, `syncDataSourceSkills()` tries each source's dedicated manifest at `/.well-known/ai/skill.json`, then falls back to the standard `/.well-known/ai` manifest (normalized via `_normalizeManifest`) — in practice the rootz.global sites only serve the latter. The fetched tool definitions appear in scan's own `/.well-known/ai` `skills` array and are callable via `/api/skill/{name}/call`.

> This config is **not** in the repo's runtime path — it lives only in `~/.epistery/config.ini` on whichever host runs scan. Without it, `DomainDiscovery.dataSources` is empty and none of these sites are indexed or searchable. Keep this block in sync if you rebuild the host or deploy from a different machine.

**Ingestion**: `autostart=false` (default) means no automatic RPC polling. Set `true` on the production host. When disabled, manual ingestion still works via `/api/monitor` and `/api/fetch`.

**Env vars**: Only `PORT` and `PORTSSL` are honored. Everything else — including dev/prod mode — comes from config.ini.

### 3. Per-service (shadow-DNS) configs

Each harness child reads its own scoped config from `~/.epistery/<hostname>/config.ini`. The hostname is an identity key (like a wallet address) — the child code does `config.setPath('/<hostname>')` to find it. Don't rename these for a local environment; they must match the same hostname used in `[harness]`.

Example — `mcp-registry` reads MySQL creds from `~/.epistery/mcp.epistery.com/config.ini`:

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
| `ingestion/interpreters/DataSourceInterpreter.mjs` | Skill manifest interpreter for configured data sources |
| `handlers/Search.mjs` | Federated search with skill orientation and @service delegation |
| `handlers/Monitor.mjs` | Monitor CRUD, type validation against registry |
| `handlers/Event.mjs` | Event queries, aggregation, timeline |
| `handlers/Discovery.mjs` | Domain submission and listing |
| `handlers/Fetch.mjs` | On-demand chain data fetching |
| `handlers/Feed.mjs` | Activity feed |
| `public/index.html` | Search UI with type-aware tab rendering |
| `public/script/expand.js` | Detail-view tab rendering for all entity types |
| `public/discovery.html` | AI Discovery browser |

## Reference

- [About](https://epistery.com/about.html) -- what Scan is for, and the principles it holds to
- [EpisteryScan](https://geist.social/wiki/EpisteryScan) -- deep technical and operational detail
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
