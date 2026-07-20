# epistery-scan — Claude notes

## Deployment policy (READ THIS)

**The live server (`/home/scan/scan` on the scan host, systemd unit `epistery-scan`) is always git-synced. The user deploys manually from git.** (Observed 2026-07-19; an older note said `/opt/epistery-scan`, which no longer exists.)

- **Do not** rsync, scp, or otherwise push local edits to the server. Even when the user gives you SSH access to "prepare the site," that is for server-side state (config dirs, systemd, dirs that aren't in the repo) — *not* for shipping code.
- If you notice the server is running stale code relative to the repo, say so. Don't bridge the gap yourself.
- The `secrets.json` and similar files in the server's app directory exist on the server but are not in the repo. Leave them alone unless the user asks.

## Domain

Live at `epistery.com` (formerly `epistery.io`; `.io` was reassigned to `../chat` on 2026-05-18). All four scan-managed domains migrated: `epistery.com`, `mcp.epistery.com`, `food.epistery.com`, `maps.epistery.com`. On-server config dirs were renamed in place; wallets and the Polygon identity contract for `epistery.com` were preserved (so the contract is technically still registered against the .io DNS verification — known inconsistency, accepted trade for preserving on-chain identity).

## SSH

`ssh ubuntu@epistery.com` (the `.io` repoint has happened — `epistery.io` now reaches the chat server and presents a different host key).
