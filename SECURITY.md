# Security Policy

This software captures a screen and injects synthetic mouse/keyboard input into a
real Windows session, and can transfer files. Treat it as sensitive.

## Responsible use

- Run it **only on machines you own or are explicitly authorized to control**.
- Only use it where personal remote access is permitted by any applicable network
  or organizational policy. It is **not** a tool for bypassing workplace controls.
- Keep the home agent up to date and behind authentication (Cloudflare Access).

## Design boundaries (by intent)

- Remote input is **off by default** and degrades to view-only if the injection
  backend is unavailable.
- A local **emergency-stop hotkey** releases all input and locks control until the
  agent process restarts.
- The Windows **secure desktop** (UAC consent, Ctrl+Alt+Del, lock/logon screen) is
  never remotely controllable.
- File transfer is sandboxed to dedicated folders; uploads block executable types
  and verify SHA-256; the transfer channel has no command-execution capability.
- User auth (Cloudflare Access) and device auth (HMAC device token) are separate;
  view and control permissions are separate; session tickets are short-lived.
- Secrets are never stored in the repository, logs, screen frames, or SDP.

## Reporting a vulnerability

Please open a **private** report via GitHub Security Advisories ("Report a
vulnerability") on this repository, or contact the maintainer privately. Do not
file public issues for undisclosed vulnerabilities. Include reproduction steps and
affected components. There is no bounty; this is a personal project, but reports
are appreciated and will be addressed on a best-effort basis.
