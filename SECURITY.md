# Security

OpenCode Canvas is a local proxy for your OpenCode server, which can read and write files and run shell commands. Treat it with the same care.

- It listens on `127.0.0.1` by default. Binding to another interface (`--hostname`) exposes your OpenCode server to that network with no additional authentication.
- The server password stays on the server side; the browser never receives it.
- Requests with a foreign `Origin`, a cross-site `Sec-Fetch-Site`, or a non-loopback `Host` are rejected, so other websites can't drive your agents through it.
- Auto-approve features let agents act without asking. They're off by default and need an explicit confirmation to enable.

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability" (Security tab) rather than in a public issue.
