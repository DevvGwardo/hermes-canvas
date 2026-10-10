# Security

Hermes Canvas is a local window onto your Hermes agent sessions. Those sessions can read and write files and run shell commands, so treat the canvas with the same care you give a terminal with an agent running in it.

- It listens on `127.0.0.1` by default. Binding to another interface (`--hostname`) exposes your sessions to that network with no additional authentication - anyone who can reach the port can steer agents and run commands. The CLI prints a warning when you bind a non-loopback address.
- There is no login of any kind: the canvas has no password or token, and neither does the browser. Reachable port = full control of the sessions it shows.
- Requests with a foreign `Origin`, a cross-site `Sec-Fetch-Site`, or a non-loopback `Host` are rejected, so other websites can't drive your agents through the canvas (CSRF and DNS-rebinding guard).
- The canvas reads Hermes' `state.db` directly and spawns `hermes chat` for prompts; it never exposes those to anything but its own local API routes (`/api/hermes/*`).
- Auto-approve features let agents act without asking (they map to `--yolo` on spawned prompts). They're off by default, and the per-session switch needs an explicit confirming second click.

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability" (Security tab) rather than in a public issue.
