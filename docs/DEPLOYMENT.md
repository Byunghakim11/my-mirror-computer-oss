# Deployment

A minimal production setup on Cloudflare's free tier. Replace every
`<placeholder>` with your own value. **Never commit secrets.**

## 0. Prerequisites

- A Cloudflare account (Workers, Pages, Durable Objects, D1).
- `npm install` and `npx wrangler login` completed.
- Two HMAC secrets you generate yourself (e.g. `openssl rand -base64 32`):
  a `SESSION_TICKET_SECRET` and a `DEVICE_AUTH_SECRET`.

## 1. D1 database

```bash
cd apps/signaling
npx wrangler d1 create my-mirror
```

Put the returned `database_id` into `apps/signaling/wrangler.jsonc`
(replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`), then apply migrations:

```bash
npx wrangler d1 migrations apply my-mirror --remote
```

## 2. Signaling Worker

```bash
cd apps/signaling
npx wrangler deploy
# note the host, e.g. my-mirror-signaling.<your-subdomain>.workers.dev
npx wrangler secret put SESSION_TICKET_SECRET
npx wrangler secret put DEVICE_AUTH_SECRET
npx wrangler secret put VIEWER_ORIGIN          # https://<your-project>.pages.dev
# optional TURN for firewalled networks:
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_API_TOKEN
```

## 3. Viewer (Cloudflare Pages)

Build with the Worker's WebSocket URL baked in, then deploy:

```bash
cd apps/viewer
VITE_SIGNALING_WS_URL="wss://my-mirror-signaling.<your-subdomain>.workers.dev/ws" npm run build
npx wrangler pages deploy dist --project-name <your-project> --branch main
```

Set the Pages **environment variables** (dashboard or `wrangler pages secret put`):
`ACCESS_ISSUER`, `ACCESS_AUD`, `ACCESS_ALLOWED_EMAILS`, `MIRROR_DEVICE_ID`, and
`SESSION_TICKET_SECRET` (**the same value as the Worker**).

## 4. Cloudflare Access

Add a self-hosted Access application in front of `https://<your-project>.pages.dev`
with a policy that allows your identity (email OTP, WebAuthn, or an IdP). Copy the
application **AUD** into `ACCESS_AUD`, and your team domain into `ACCESS_ISSUER`
(`https://<your-team>.cloudflareaccess.com`).

## 5. Home agent

Create a private, uncommitted launcher that sets the environment (see
`.env.example`) and runs the agent. At minimum: `MIRROR_DEVICE_ID`,
`MIRROR_SESSION_ID`, `MIRROR_DEVICE_TOKEN` (mint offline with the shared
`DEVICE_AUTH_SECRET`), `MIRROR_WS_URL`, and the feature switches
(`MIRROR_CONTROL_ENABLED`, `MIRROR_FILES_ENABLED`, `MIRROR_CLIPBOARD_ENABLED`).

```powershell
cd apps/host-agent
.\.venv\Scripts\python -m mirror_host_agent
```

For remote input over elevated windows (e.g. Task Manager), run the agent with
administrator rights; `setup-elevated-agent.ps1` registers a highest-privilege
logon scheduled task. The UAC consent dialog and lock screen remain uncontrollable
by design.

## Notes

- The `SESSION_TICKET_SECRET` **must be byte-identical** on the Worker and the
  Pages Function. Prefer `wrangler secret bulk <file>` over shell pipes to avoid
  trailing newlines.
- Redeploy Pages to the production branch with `--branch main`.
