# Contributing

Thanks for your interest. This is a small personal project shared in the hope it
is useful; contributions and forks are welcome under the Apache-2.0 license.

## Ground rules

- **Never commit secrets or account identifiers.** No API tokens, device tokens,
  Access AUDs, real deployment hostnames, or personal paths. Config lives in
  environment variables and `wrangler secret`; see `.env.example`.
- Keep the safety boundaries intact: remote input off by default, view-only
  fallback, emergency stop, input validation, and the file-transfer sandbox. Do
  not add command-execution to the file channel.
- Do not log screen frames, keystroke contents, full SDP, or mouse coordinates.

## Development

```bash
npm install
npm run verify:local     # typecheck + tests + build
```

- TypeScript/React for the viewer and Worker; Python 3.12 for the agent.
- Add tests for new behavior. The wire format lives in `packages/protocol` — change
  the schema there, and mirror any validation in the agent.
- Small, focused PRs with a clear description are easiest to review.

## Reporting issues

Use GitHub issues. For anything security-sensitive, follow [SECURITY.md](./SECURITY.md).
