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
pre-push hook; CI runs it as its own job.

## How the stack boots

`global-setup.ts` calls `stack.ts`, which spawns `bun src/index.ts` (the real
backend, `NODE_ENV=development`, `SUBSHELL_TEST_MODE=false`) with:

- `SERVER_PORT=3199` (see `ports.ts`), far from the dev 3080, no collision
  with a running `turbo watch dev`.
- a fresh `mkdtemp` dir for `DATABASE_PATH` and `SUBSHELL_SERVER_DATA_DIR`, wiped on
  teardown, so every run is a pristine first-boot instance.
- an isolated `HOME` with an empty `.ssh/config`, so SSH resolution uses an
  explicit config instead of inheriting user or system settings such as Ubuntu's
  environment forwarding defaults.
- `PI_PATH` pointed at `e2e/stub/pi`, a loop-forever script that answers
  `--version` for detection, so the harness registry reports `pi` installed and
  subshells launch a real tmux pane without any agent CLI.

The backend serves the frontend bundle, so **one origin = the whole app**; all
specs use `baseURL` from `ports.ts`.

Spec `14` adds a THIRD process: `stack.ts` also spawns `bun fake-registry.ts
3198`, a `Bun.serve` fake npm registry (it must be a child process because the
Playwright runner is Node, so globalSetup cannot host `Bun.serve` itself). It
packs `e2e/fixtures/plugin-demo/` with `bun pm pack` at boot, computes the
sha512 over the real tgz bytes, and serves that one package; the backend child's
`SUBSHELL_PLUGIN_REGISTRY_URL` points at it, so no spec in the suite can ever
dial a real registry. It is torn down with the stack.

Spec `19` adds a FOURTH: `bun fixtures/fake-oidc-server.ts 3197`, a
`Bun.serve` fake OIDC issuer (the same standalone-bun child for the same
runner reason) reused from Task 7's in-test fake. Unlike the registry it is
BROWSER-reachable, because spec 19's round trip is a real navigation through
`/authorize`. `PUT /_profile` swaps the `/userinfo` answer between flows;
that is the subprocess's addition over the in-test `setProfile`. Spec 19 seeds
its providers via the admin cookie at `POST /api/auth-providers` (whose save gate
runs discovery against this fake), and no spec ever dials a real IdP.

Every fixed port in `ports.ts` takes an env override (`E2E_PORT_BACKEND`,
`E2E_PORT_FAKE_REGISTRY`, `E2E_PORT_FAKE_IDP`, `E2E_PORT_ONBOARDING`,
`E2E_PORT_SSH`, `E2E_PORT_CONNECT`, `E2E_PORT_RELAY`, `E2E_PORT_FORWARDS`) with the committed
defaults unchanged, the escape hatch for two suites running side by side on one
machine, which the defaults collide on.

`E2E_TMUX_TMPDIR` overrides the short `/tmp` root used for isolated tmux
sockets. Use an existing, short directory when `/tmp` is full; `TMPDIR` still
controls other fixtures. Keep the resolved path short enough for Unix sockets.

Spec `22` boots its own backend too (port 3201) for a reason the shared stack
cannot serve: the ssh tier reads the connecting account's HOME and bun caches
`os.homedir()` per process, so that child is SPAWNED with `HOME=<fixture home>`
plus the spec's `ssh-agent` socket, on its own temp DB/data dir/tmux base.
Spec `23` repeats that boot on port 3202 (its own fresh slot, since spec 22's
instance lives across its retries) and drives the same fixture through the
browser: the SSH flow inside the new-subshell dialog, the gate flip, and a
view-only SSH pane.

Spec `12` extends the stack itself: it spawns the **real `subshell` from
source** (`bun apps/node/agent/src/main.ts enroll|run` via `stub/client.ts`, with
`SUBSHELL_CONFIG_HOME` and `TMUX_TMPDIR` pointed at temp dirs so its config and its
daemonised tmux servers are quarantined). No hand-written fake node exists:
the master plan's `subshell-fake.ts` was superseded before it was written
(plan deviation #1, recorded in the nodes spec's Errata).

## Spec-ordering contract (workers: 1)

`playwright.config.ts` forces `workers: 1` and files run in alphabetical order
against ONE shared database:

- `00-smoke` proves the pristine stack.
- `01-setup-wizard` creates the admin (`.test` email TLD: better-auth rejects
  digit TLDs like `.e2e`) and writes `.auth/admin.json`.
- The specs after it load that storage state via `ADMIN_STATE` from
  `helpers.ts` (`04`–`19`, less `15`, which boots its own clean
  machine and loads no state; `02` deliberately stays anonymous: it pins
  the 401 boundary itself; `19` reads it through an admin `APIRequestContext`
  for its provider seeding, while every browser context it drives stays
  anonymous).
- Two files share the `06-` prefix: `06-split-to-workspace` sorts before
  `06-subshell-lifecycle` and so runs between `05` and it. Both depend only on
  `01`, and the split spec closes the subshells it launches, so the order
  between the two does not matter: it is named here so nobody reads the
  duplicate prefix as an accident (`09` and `10` already carry pairs).

`.auth/admin.json` is path-portable: `ADMIN_STATE` in `helpers.ts` resolves it
to an absolute path from `import.meta.url` (always `e2e/.auth/admin.json`), and
both the writer (spec `01`) and the readers (`04`–`19`, less `15`) use that same constant;
so the CWD the run is launched from never matters.

## What the terminal assertions may use

The app loads **no renderer addon**: xterm 6 paints through its own DOM
renderer (see the long comment in `components/subshell-terminal.tsx`), so pane
text IS technically in the DOM. Do not assert on it anyway: it is an emulator
implementation detail: viewport rows only (scrollback is not rendered), split
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
the neighbouring contract (that the attach URL carries the client's cols/rows
and no replayed row exceeds them), while the `geometry` frame itself is pinned
by server unit tests (`ws/__tests__/subshell-ws-local-attach.test.ts`); no e2e
spec asserts the client grid yet. See `.sdd` design notes or the spec doc,
"Terminal gotchas", and spec `06` for the pattern.

Channels are machine-facing (no browser UI): spec `07` is API-only, seals with
real crypto from `seal.ts` (a thin re-export of `@internal/mcp-core`, the same
module the backend and node run, so drift is structurally impossible), and
asserts recipient-filtered reads.

## SSH container coverage

`23-connect-flow.spec.ts` and `26-ssh-forwarding.spec.ts` require a running
Docker-compatible daemon. Testcontainers builds
`fixtures/ssh-container/Dockerfile`, publishes sshd on a random port, and owns
container cleanup. Missing Docker fails setup rather than silently skipping
coverage. The container creates disposable developer and operator accounts for
real password login; no host accounts or SSH files are changed. Host keys are
generated under the test's temporary directory and trusted explicitly by the
connecting process. The image also carries `curl`, `iproute2` and `darkhttpd`,
and its sshd runs `GatewayPorts clientspecified`: spec 26 reads each port
forward from the side that owns it, and proves each wide bind as an address
pair - a loopback-bound port does not answer a dial to its machine's
interface address, the wide one does, destination-side `-R` read from inside
the container. The dial never crosses from the container to the job's own
network: on CI the job is itself a container, and docker does not route
sibling containers across user-defined networks (measured 2026-10-16).

The browser exercises key login, password prompts and retry, terminal I/O,
view-only sharing, and saving named SSH presets for distinct usernames on one host. Password checks
cover HTTP bodies, terminal history, preset responses, and database bytes;
Playwright failure traces can still contain fixture passwords typed into the
terminal, so these are disposable test credentials.

Specs 22 and 23-ssh-relay retain their host-process fixtures for terminal
lifecycle and cross-node cryptographic relay coverage.

Spec 24 covers SSH preset CRUD, restoring authentication choices, save-before-launch retries, and the browser’s first-connection confirmation and cancellation;
spec 23-ssh-relay checks real discovery and acceptance before relay authentication.
Spec 25 runs the browser signer against a real sshd on the host (not
Testcontainers): it needs `ssh`, `sshd` and `ssh-keygen` present, and it skips
loudly naming the missing binaries where they are not.
Run all SSH specs together with `01-setup-wizard.spec.ts` (which seeds the account for spec 24).
CI mounts its Docker socket into the e2e job so Testcontainers can start the
same destination fixture.

## SSH documentation screenshots

After building `@internal/server-web`, run `bun e2e/capture-ssh-docs.ts` from
the repository root. It starts the isolated e2e stack, two real node daemons,
a disposable SSH agent, and a Testcontainers destination. Docker and the
Playwright Chromium browser are required. The normal `E2E_PORT_*` overrides
apply when another suite is running.

The script writes one cropped PNG to `apps/docs/public/screenshots/`, from a
real first-connection refusal. It cancels confirmation and checks that no
destination trust was saved, then cleans up its processes and temporary state.
Review the image and update its intrinsic dimensions in `guides/ssh.mdx` if the
layout changes. Never point it at the live server.

For the other documentation screenshots, run `bun e2e/capture-docs.ts` after
building the SPA. It uses the same isolated stack with sample presets, prompts,
a workspace, and real terminal sessions running a small temporary project.
No coding-agent responses are simulated. The script also refreshes the six
marketing-site WebP copies using `ffmpeg`, which must be installed.

Review every capture, update intrinsic dimensions in the referring MDX and
`apps/website/components/feature-showcase.tsx`, and check the captions against
the actual controls. The example address and QR code are public sample values;
no setup key is generated. Remove obsolete assets and their references together.

Both capture scripts use `screenshot.ts` for a 12px page-colored margin and 2×
pixel density. The helper hides unrelated UI and modal backdrops only during
capture; the photographed controls and their content remain unchanged. Keep
PNG dimensions and the lossless marketing WebP copies at native resolution.
The sites supply the same single border around each image, without extra padding.
