# E2E AGENTS.md

Playwright end-to-end suite for mote: a real browser against the backend
serving the built SPA, a real temp-file SQLite DB, and real tmux sessions.

## Commands

```bash
bun run test:e2e           # headless run (boots + tears down the whole stack)
bun run test:e2e:ui        # Playwright UI mode (same stack)
bunx playwright install chromium   # one-time browser download
E2E_VERBOSE=1 bun run test:e2e     # stream backend stdout/stderr for debugging
```

Run from the repo root via the root `test:e2e` script (which routes here), or
inside `e2e/` directly. Never part of `turbo test`, `bun run test`, or the
pre-push hook — CI runs it as its own job.

## How the stack boots

`global-setup.ts` calls `stack.ts`, which spawns `bun src/index.ts` (the real
backend, `NODE_ENV=development`, `MOTE_TEST_MODE=false`) with:

- `SERVER_PORT=3199` (see `ports.ts`) — far from the dev 3080, no collision
  with a running `turbo watch dev`.
- a fresh `mkdtemp` dir for `DATABASE_PATH` and `SESSION_DATA_DIR` — wiped on
  teardown, so every run is a pristine first-boot instance.
- `PI_PATH` pointed at `e2e/stub/pi` — a loop-forever script that answers
  `--version` for detection, so the harness registry reports `pi` installed and
  sessions launch a real tmux pane without any agent CLI.

The backend serves the frontend bundle, so **one origin = the whole app**; all
specs use `baseURL` from `ports.ts`.

## Spec-ordering contract (workers: 1)

`playwright.config.ts` forces `workers: 1` and files run in alphabetical order
against ONE shared database:

- `00-smoke` proves the pristine stack.
- `01-setup-wizard` creates the admin (`.test` email TLD — better-auth rejects
  digit TLDs like `.e2e`) and writes `.auth/admin.json`.
- `02`–`07` load that storage state via `ADMIN_STATE` from `helpers.ts`.

`.auth/admin.json` is path-portable: `ADMIN_STATE` in `helpers.ts` resolves it
to an absolute path from `import.meta.url` (always `e2e/.auth/admin.json`), and
both the writer (spec `01`) and the readers (`02`–`07`) use that same constant —
so the CWD the run is launched from never matters.

## What the terminal assertions may use

xterm.js paints through the **WebGL addon into a `<canvas>`** — pane text is
NOT in the DOM and must never be asserted. Prove liveness through server/
network truth instead: `POST /api/auth/ws-token` returns 200, the
`/ws?session=…` WebSocket upgrade fires, the "reconnecting…" pill is absent,
and status chips (`working` / `running` on the detail badge / `ended` /
`exited`) reflect the API. See `.sdd` design notes or the spec doc,
"Terminal gotchas", and spec `06` for the pattern.

Channels are machine-facing (no browser UI): spec `07` is API-only, seals with
real `jose` crypto from `seal.ts` (verbatim mirror of
`@internal/mcp-core`'s `crypto.ts`), and asserts recipient-filtered reads.
