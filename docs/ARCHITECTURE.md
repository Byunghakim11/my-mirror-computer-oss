# Architecture

## Components

| Component | Path | Stack | Role |
|---|---|---|---|
| Viewer | `apps/viewer` | React 19, Vite, TypeScript | Browser UI, WebRTC peer, input capture, Pages Function `/session/ticket` |
| Signaling | `apps/signaling` | Cloudflare Worker, Durable Object, D1 | `/ws` room, `/turn` credentials, `/health` |
| Host agent | `apps/host-agent` | Python 3.12, aiortc | Screen capture, WebRTC answer, `SendInput` injection |
| Protocol | `packages/protocol` | TypeBox / Ajv | Shared message schemas + session-ticket signer |

## Connection flow

1. The browser loads the viewer from **Cloudflare Pages**, behind **Cloudflare
   Access** (the user authenticates).
2. The viewer calls the same-origin Pages Function **`/session/ticket`**, which
   verifies the Access JWT (issuer, audience, signature, email allowlist) and
   mints a short-lived **HMAC session ticket**.
3. The viewer opens **`wss://…/ws?ticket=`** on the signaling **Worker**, which
   verifies the ticket with the same secret and joins the device's Durable Object
   room (one session at a time).
4. The home **agent** cannot pass Access, so it authenticates to the same `/ws`
   with an **HMAC device token** (separate secret, issuer, and role).
5. Viewer and agent exchange SDP/ICE through the room and connect **peer-to-peer**.
   Media and the control/file DataChannels flow directly; the server never relays
   media on the default path.
6. **STUN** provides server-reflexive candidates for NAT traversal. When a network
   blocks UDP, **`/turn`** issues short-lived Cloudflare Realtime TURN credentials
   and media relays over TCP/TLS 443.

## Why Pages + Worker (two origins)

Cloudflare Access can protect a `*.pages.dev` project but **cannot** protect a
`*.workers.dev` host (the Access app domain must be an active zone in the account).
So the Access-gated surface (viewer + `/session/ticket`) lives on **Pages**, and
the un-gated `/ws` + `/turn` live on a separate **Worker**. The session ticket is
carried as a URL query parameter, so the cross-origin WebSocket needs no cookie.

## Control and input safety

- Control is granted only when the viewer requests it **and** local policy allows
  it **and** injection is available (Windows). Otherwise the session is view-only.
- Each grant has a fixed TTL; re-requesting does not extend an active grant.
- The agent validates every control message: monotonic sequence, timestamp skew,
  a **key-code allowlist**, normalized pointer bounds, wheel clamps, and a
  per-second action rate limit. A watchdog releases all input after inactivity.
- Keyboard input has no Meta/Win key and cannot reach the secure desktop.
- Korean/other IME text is injected as Unicode (`KEYEVENTF_UNICODE`) from composed
  text, independent of the host keyboard layout.

## File transfer

A dedicated ordered DataChannel (`file-v1`) carries JSON envelopes plus raw binary
chunks, separate from control so bulk bytes never starve input.

- **Upload** (viewer → agent): writes only into a sandboxed `Incoming/` folder;
  filenames are sanitized, executable types blocked, size capped, streamed to a
  temp file, and atomically renamed only on SHA-256 match. Received files get the
  Windows Mark-of-the-Web.
- **Download** (agent → viewer): lists and streams only files directly inside a
  sandboxed `Outgoing/` folder; paths are resolved and confirmed inside the folder
  (no traversal, no symlink escape); the viewer verifies size + SHA-256 before the
  browser download.

## What is never persisted or logged

Screen frames, keystroke contents, full SDP, private keys, and long-lived tokens
are never stored in D1, the Durable Object, or logs. Audit records (if enabled)
keep only direction, size bucket, result, and error code.
