# epistery-scan

Epistery Scan is like etherscan, but host focused rather than chain specific.

The server has a list of agent contracts to track, along with the contracts they may
spawn and all the events created. Contracts may reside on different chains.
By stashing the event data as it happens and routinely refreshing, the server can
provide fast and robust queries for all the agents operating in the epistery 
ecosystem.

Epistery Scan can play a further role as a message router. Many epistery objects
anticipate messaging each other through chain transactions. Epistery Scan can
translate that system into the real world of instant messaging. It can also perform
search beyond just transactional data as it will know how the contracts it monitors are
structured, so where to find the data and how to read it if given permission.

## Profile

This is a node express application that integrates epistery for access control and utility.
It provides both an /api and a gui. The database is mongo. We will use the /metric-im/componentry
framework for UI and module management.

All system configuration is to be managed with the Epistery Config module.

## Architecture

The system naturally has three main components, ingestion, storage and control.

**Ingestion** is made up of
connectors that normalize lookup across diverse sources (chains), as well as interpreters that know how
to gather the events and facts of each contract type. There are just a handful of contracts currently active in the Epistery ecosystem

* /rootz/epistery/contracts/Agent.sol - Contract representing a domain host. Manages access lists and agent attributes
* /rootz/epistery/contracts/IdentityContract.sol - Contract which binds a number of browser rivets into a single identity. Essentially multisig.
* /geistm/adnet-factory/contracts/CampaignWallet.sol - Contract the operates an ad campaign

**Storage** has structured data and event data. The structured data should organize objects by type and relationship.
The event data is a large loosely typed collection of all event records, across all objects. Each record
has a timestamp, source, entityId and type. The rest of the attributes are arbitrary name/value expressions
pertinent to the context. This structure is ideal for mongo aggregation queries.

**Control** is the UI humans use to manage the system and search for data to be displayed in tables, charts
or reports. It is also the api apps use to do the same with raw data exchange. Access control for
both UI and the API is managed by epistery. For a reference implementation see /epistery/wiki

The main page of the UI should present search and show results, like etherscan, in a tabbed block which
shows, transactions, object data. Control automatically informs Ingestion for what to monitor by what people
search. There should also be an api call to trigger this manually. For example, When an epistery host
creates a new IdentityContract it will tell epistery-scan to start monitoring the new address.

This app is not an agent. It is a standalone server managing a database behind a public facing website.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure MongoDB and blockchain RPC endpoints:
```bash
cp config.example.json ~/.epistery/{your-domain}/config.json
```

Edit the config to set:
- MongoDB connection string
- Chain RPC URLs (ethereum, polygon, etc.)
- Polling interval

3. Start the server:
```bash
npm start
```

The server will run on http://localhost:3000 by default.

## Usage

### Web Interface

Visit http://localhost:3000 to use the search interface. You can:
- Search for addresses (0x...)
- Search for transaction hashes
- Search by domain name
- View entity details and events in tabbed format

### API Endpoints

**Search**
- `GET /api/search?q=0x...` - Search for addresses or transactions

**Monitor Management**
- `POST /api/monitor` - Add a contract to monitor
  ```json
  { "address": "0x...", "chain": "ethereum", "type": "Agent" }
  ```
- `GET /api/monitor` - List all monitors
- `DELETE /api/monitor/:address` - Remove a monitor

**Event Queries**
- `GET /api/events?entityId=0x...&limit=50` - Query events
- `GET /api/events/stats` - Get event statistics
- `GET /api/events/timeline?interval=day` - Get event timeline
- `POST /api/events/aggregate` - Run MongoDB aggregation

### Monitoring Contracts

When an epistery host creates a new contract (Agent, IdentityContract, etc.),
it should notify epistery-scan to start monitoring:

```bash
curl -X POST http://localhost:3000/api/monitor \
  -H "Content-Type: application/json" \
  -d '{"address":"0x123...","chain":"ethereum","type":"Agent"}'
```

## Architecture

**Database Collections:**
- `entities` - Contract data indexed by address and type
- `events` - Event records with timestamp, source, entityId, type, and arbitrary attributes
- `monitors` - List of addresses being tracked

**Ingestion:**
- Chain connectors normalize access across different blockchains
- Contract interpreters know how to read each contract type (Agent, IdentityContract, CampaignWallet)
- Polling manager refreshes data at configured intervals

**API:**
- Search handler provides Etherscan-like search
- Monitor handler manages tracked addresses
- Event handler queries and aggregates event data

## Contract Types

**Agent.sol** (`/rootz/epistery/contracts/Agent.sol`)
- Domain host contracts
- Manages access lists and agent attributes
- Events: AccessGranted, AccessRevoked, AttributeSet

**IdentityContract.sol** (`/rootz/epistery/contracts/IdentityContract.sol`)
- Binds multiple browser devices into single identity (multisig)
- Events: RivetAdded, RivetRemoved, ThresholdChanged

**CampaignWallet.sol** (`/geistm/adnet-factory/contracts/CampaignWallet.sol`)
- Operates ad campaigns in Adnet
- Events: CampaignCreated, ImpressionRecorded, ClickRecorded, PaymentMade

## Reference

* /rootz/epistery - The core module that establishes the capabilities and purpose of this system
* /epistery/ - See CLAUDE.md. This is a folder of agents built with epistery
* /metric-im/metric-server - We will borrow heavily from this module to govern how we store, query and present event data
* /metric-im/componentry - a lightweight framework for componentized widgets.
* /rootz/rhonda - An example app built with componentry
* /epistery/wiki - An example app for epistery integration and access control
* run `epistery https://wiki.rootz.global/` - A wiki with more context and insight into the epistery concept.

