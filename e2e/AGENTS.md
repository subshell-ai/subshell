# E2E AGENTS.md

Playwright end-to-end suite for subshell: a real browser against the backend
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
backend, `NODE_ENV=development`, `SUBSHELL_TEST_MODE=false`) with:

- `SERVER_PORT=3199` (see `ports.ts`) — far from the dev 3080, no collision
  with a running `turbo watch dev`.
- a fresh `mkdtemp` dir for `DATABASE_PATH` and `SUBSHELL_SERVER_DATA_DIR` — wiped on
  teardown, so every run is a pristine first-boot instance.
- `PI_PATH` pointed at `e2e/stub/pi` — a loop-forever script that answers
  `--version` for detection, so the harness registry reports `pi` installed and
  subshells launch a real tmux pane without any agent CLI.

The backend serves the frontend bundle, so **one origin = the whole app**; all
specs use `baseURL` from `ports.ts`.

Spec `14` adds a THIRD process: `stack.ts` also spawns `bun fake-registry.ts
3198` — a `Bun.serve` fake npm registry (it must be a child process because the
Playwright runner is Node, so globalSetup cannot host `Bun.serve` itself). It
packs `e2e/fixtures/plugin-demo/` with `bun pm pack` at boot, computes the
sha512 over the real tgz bytes, and serves that one package; the backend child's
`SUBSHELL_PLUGIN_REGISTRY_URL` points at it, so no spec in the suite can ever
dial a real registry. It is torn down with the stack.

Spec `12` extends the stack itself: it spawns the **real `subshell` from
source** (`bun apps/node/agent/src/main.ts enroll|run` via `stub/client.ts`, with
`SUBSHELL_CONFIG_HOME` and `TMUX_TMPDIR` pointed at temp dirs so its config and its
daemonised tmux servers are quarantined). No hand-written fake agent exists —
the master plan's `subshell-fake.ts` was superseded before it was written
(plan deviation #1, recorded in the nodes spec's Errata).

## Spec-ordering contract (workers: 1)

`playwright.config.ts` forces `workers: 1` and files run in alphabetical order
against ONE shared database:

- `00-smoke` proves the pristine stack.
- `01-setup-wizard` creates the admin (`.test` email TLD — better-auth rejects
  digit TLDs like `.e2e`) and writes `.auth/admin.json`.
- The specs after it load that storage state via `ADMIN_STATE` from
  `helpers.ts` (`04`–`14`; `02` deliberately stays anonymous — it pins the
  401 boundary itself).
- Two files share the `06-` prefix: `06-split-to-workspace` sorts before
  `06-subshell-lifecycle` and so runs between `05` and it. Both depend only on
  `01`, and the split spec closes the subshells it launches, so the order
  between the two does not matter — it is named here so nobody reads the
  duplicate prefix as an accident (`09` and `10` already carry pairs).

`.auth/admin.json` is path-portable: `ADMIN_STATE` in `helpers.ts` resolves it
to an absolute path from `import.meta.url` (always `e2e/.auth/admin.json`), and
both the writer (spec `01`) and the readers (`04`–`14`) use that same constant —
so the CWD the run is launched from never matters.

## What the terminal assertions may use

The app loads **no renderer addon** — xterm 6 paints through its own DOM
renderer (see the long comment in `components/subshell-terminal.tsx`), so pane
text IS technically in the DOM. Do not assert on it anyway: it is an emulator
implementation detail — viewport rows only (scrollback is not rendered), split
into style-run spans that break a phrase across elements, and whitespace-padded
to the grid width. Prove liveness through server/network truth instead: `POST /api/auth/ws-token` returns 200, the
`/ws?subshell=…` WebSocket upgrade fires, the "reconnecting…" pill is absent,
and status chips (`working` / `running` on the detail badge / `ended` /
`exited`) reflect the API.

The client's GRID is now a testable contract and is fair game: the server
announces the pane's real size in a `geometry` frame and the client pins its
terminal container to exactly that grid, so `.xterm-rows > div` count equals
the pane's rows, and the container's inline width/height are an exact function
of the grid and the cell size (`lib/terminal-geometry.ts`). Spec `10` covers
the neighbouring contract — that the attach URL carries the client's cols/rows
and no replayed row exceeds them — while the `geometry` frame itself is pinned
by server unit tests (`ws/__tests__/subshell-ws-local-attach.test.ts`); no e2e
spec asserts the client grid yet. See `.sdd` design notes or the spec doc,
"Terminal gotchas", and spec `06` for the pattern.

Channels are machine-facing (no browser UI): spec `07` is API-only, seals with
real crypto from `seal.ts` (a thin re-export of `@internal/mcp-core` — the same
module the backend and agent run, so drift is structurally impossible), and
asserts recipient-filtered reads.
