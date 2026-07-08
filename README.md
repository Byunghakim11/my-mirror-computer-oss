# My Mirror Computer

A personal, self-hosted remote desktop: view and control your **Windows 11** home
PC from a browser on another machine — no software installed on the client, no
router port forwarding, and no public inbound ports.

Screen video travels **peer-to-peer over WebRTC**. Cloudflare is used only for
authentication and connection setup (signaling), never as a media relay for the
default path. A small Python agent runs on the home PC; everything the browser
sends is gated by an explicit local "control allowed" switch.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

> **Security notice.** This project injects synthetic mouse/keyboard input into a
> real Windows session and can transfer files. Run it **only on machines you own
> and are authorized to control**, and only where personal remote access is
> permitted by any applicable network or organizational policy. It is not a tool
> for bypassing workplace controls. See [SECURITY.md](./SECURITY.md).

---

## Features

- **Live screen** — Windows Desktop Duplication capture to H.264 (VP8 fallback),
  720p/15fps or 540p/10fps profiles, switchable mid-session.
- **Remote control** — mouse and a whitelisted keyboard set over a WebRTC
  DataChannel, **off by default** and degraded to view-only if injection is
  unavailable.
- **Mobile touch** — tap = click, drag = drag, 2s hold = right click; a soft
  keyboard that forwards IME-composed text (Korean and other scripts) as Unicode.
- **File transfer** — sandboxed upload (`Incoming/`) and download (`Outgoing/`)
  on a dedicated channel, with SHA-256 integrity and executable-type blocking on
  upload.
- **Clipboard** — text from the home PC, staged in the viewer (never auto-written).
- **Auth** — Cloudflare Access on the viewer, short-lived HMAC session tickets for
  the viewer and device tokens for the agent. Secrets never touch the repo.
- **Safety** — per-grant TTL, sequence/timestamp/rate-limit checks, an input
  watchdog, and a local emergency-stop hotkey on the home PC.

## Architecture

```
 Browser (viewer)                Cloudflare                    Home PC (agent)
 +--------------+   Access +    +--------------+              +---------------+
 | React + Vite |  session      | Pages        |              | Python 3.12   |
 | WebRTC peer  |  ticket       |  - viewer    |   device     | aiortc        |
 |              | <===========> |  - /session/ |   token      | Desktop Dup   |
 |              |               |    ticket fn | <===WS /ws==> | SendInput     |
 |              |   WSS /ws     +--------------+   signaling  |               |
 |              | <===========> | Worker       |              |               |
 |              |               |  - /ws  (DO) |              |               |
 +------+-------+               |  - /turn     |              +------+--------+
        |                       +--------------+                     |
        |            WebRTC media + control DataChannel (P2P,         |
        +-------------  STUN, TURN relay only when firewalled) -------+
```

- **Signaling Worker** (`apps/signaling`) — `/ws` WebSocket brokered by a Durable
  Object (single-session room), `/turn` short-lived ICE credentials, `/health`.
- **Viewer** (`apps/viewer`) — React app + a Cloudflare Pages Function
  `/session/ticket` that verifies the Access JWT and mints a session ticket.
- **Host agent** (`apps/host-agent`) — captures the screen, answers WebRTC, and
  injects validated input via `SendInput`.
- **Protocol** (`packages/protocol`) — shared TypeBox/Ajv message schemas and the
  session-ticket signer, the single source of truth for the wire format.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full design and the key
decisions (Pages+Worker topology, auth chain, TURN, file sandbox).

## Repository layout

```
apps/
  viewer/        React + Vite viewer, Pages Functions (session ticket)
  signaling/     Cloudflare Worker + Durable Object + D1
  host-agent/    Python 3.12 agent (aiortc, Desktop Duplication, SendInput)
packages/
  protocol/      shared message schemas + session ticket (TypeBox/Ajv)
scripts/         local e2e / origin-matrix / token-mint helpers
```

## Prerequisites

- **Node.js >= 22** and npm (workspaces)
- **Python 3.12** (home agent) — Windows only for real capture/input
- A **Cloudflare** account for production (Workers, Pages, Durable Objects, D1;
  optional Access and Realtime TURN). Local development needs none of this.

## Local development

```bash
npm install
npm run verify:local        # typecheck + tests + build (viewer, signaling, protocol)

# terminal 1 - viewer
npm run dev --workspace @mirror/viewer

# terminal 2 - signaling Worker
npm run dev --workspace @mirror/signaling
```

The home agent (Windows):

```powershell
cd apps/host-agent
python -m venv .venv
.\.venv\Scripts\pip install -e .
# configure env vars (see .env.example), then:
.\.venv\Scripts\python -m mirror_host_agent
```

Copy [.env.example](./.env.example) and fill in your own values. Nothing in this
repo contains real secrets or account identifiers.

## Production deployment

Full step-by-step (Worker + Pages + Access + secrets + agent) is in
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md). In short:

1. Deploy the signaling Worker (`wrangler deploy` in `apps/signaling`).
2. Build the viewer with `VITE_SIGNALING_WS_URL` and deploy to Pages.
3. Put Cloudflare Access in front of the Pages project.
4. Set the shared/secret env values on both surfaces (never commit them).
5. Mint a device token and run the agent on the home PC.

## Safety boundaries

- Remote input is **off** until the home PC explicitly enables it, and drops to
  view-only if the injection backend is unavailable.
- A **local emergency-stop hotkey** releases all input and locks control until the
  agent restarts.
- The **secure desktop** (UAC consent, Ctrl+Alt+Del, lock screen) is never
  remotely controllable — a hard OS boundary this project respects.
- File transfer is sandboxed to dedicated folders; uploads block executable types
  and verify SHA-256; the channel has no command-execution capability.
- Unknown protocol fields, out-of-range coordinates, oversized payloads, and
  replayed/out-of-order sequences are rejected.

## Testing

```bash
npm test              # protocol + viewer + signaling + origin matrix + python
npm run typecheck
```

Python agent tests: `PYTHONPATH=apps/host-agent/src python -m unittest discover -s apps/host-agent/tests`.

## License

[Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE).

## Disclaimer

Provided "as is", without warranty. You are responsible for how you deploy and use
it, including compliance with the policies of any network you connect from or to.
