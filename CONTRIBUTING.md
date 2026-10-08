# Contributing

Thanks for helping out. The project is small and dependency-free on purpose: plain TypeScript in the browser, Bun on the server.

## Setup

```sh
bun install
bun run demo      # simulated sessions, no OpenCode needed
bun run dev       # against your local OpenCode, with hot reload
```

## Before you open a pull request

```sh
bun run typecheck
bun test
```

- Keep layouts, formatting and status logic as pure functions with tests (`test/`).
- Try UI changes in demo mode (`?demo=1`) and against a real OpenCode server.
- If you add an OpenCode endpoint, list it in the README's "How it works" section. The full API spec is at `GET /openapi.json` on any OpenCode v2 server.

## Reporting bugs

Include your OpenCode version (`opencode --version`), browser, and what you expected versus what happened. Screenshots help, but check them for session content you don't want to share.
