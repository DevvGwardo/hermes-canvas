# Contributing

Thanks for helping out! The project is small and dependency-free on purpose: plain TypeScript in the browser, Bun on the server.

## Setup

```sh
bun install
bun run demo      # simulated sessions, no Hermes install needed
bun run dev       # against your local Hermes store, with hot reload
```

## Before you open a pull request

```sh
bun run typecheck
bun run test       # runs `bun test --isolate` so globals and timers stay isolated per file
bun run build
```

- Keep layouts, formatting and status logic as pure functions with tests (`test/`).
- Try UI changes in demo mode (`?demo=1`) and against a real Hermes install.
- Endpoints live in [`src/server/server.ts`](src/server/server.ts) under `/api/hermes/*` (plus `/canvas/config`); if you add or change one, update the endpoint summary in [the README's "How it works" section](README.md#how-it-works).

## Reporting bugs

Include your Hermes version (`hermes --version`), browser, and what you expected versus what happened. Screenshots help, but check them for session content you don't want to share.
