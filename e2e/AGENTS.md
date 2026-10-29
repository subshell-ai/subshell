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
pre-push hook; CI runs it in the selected integration job. The workspace
`test` script covers only the capture helpers, not browser scenarios.

### Standalone live security probes

`bun e2e/verify-live-security.ts` boots its own disposable stack and checks
HTTP/WS authorization, Chromium preview isolation, sharing revocation, uploads,
and a real enrolled node. It never targets `SUBSHELL_BASE_URL`. Build workspace
dependencies and the SPA first, and install Playwright Chromium. Choose unused
`E2E_PORT_BACKEND`, `E2E_PORT_FAKE_REGISTRY` and `E2E_PORT_FAKE_IDP` values;
the runner checks those ports before booting. Unset inherited `SUBSHELL_API_KEY`,
`SUBSHELL_BASE_URL`, `SUBSHELL_ID`, `SUBSHELL_DATA_DIR`, `SUBSHELL_NAME`, `TMUX`
and `TMUX_PANE` when invoking it from an agent pane.

`LIVE_SECURITY_REPORT` selects the redacted JSON output (default
`/tmp/subshell-live-security.json`). `LIVE_SECURITY_NGINX_IMAGE` adds a real
nginx positive control and proxy-directive attack using a disposable private
canary; use an immutable image digest. This optional fixture requires Docker
with Linux host networking and binds loopback port 43293, overridable through
`LIVE_SECURITY_NGINX_PORT`. Without that variable, the nginx checks do not run.
The runner removes its accounts, processes, container and scratch data on exit;
it returns nonzero if a probe or cleanup fails. The completed audit and its
scope are recorded in [the security history](../docs/security-actionable.md).

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
`E2E_PORT_SSH`, `E2E_PORT_CONNECT`, `E2E_PORT_RELAY`, `E2E_PORT_FORWARDS`,
`E2E_PORT_PREVIEW_HTTP`, `E2E_PORT_PREVIEW_CDP`) with the committed
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
CI runs integration checks on a bare Ubuntu runner, so Testcontainers uses
the host Docker daemon and its mapped ports directly.

Spec `27-ssh-security` adds live adversarial checks for cookie-only SSH routes,
destination injection, account-bound host-key confirmation, conflicting pins,
and local-key preparation ownership, replay and concurrency. It uses the shared
stack's admin from spec 01 and its own temporary sshd; it sends no private keys
to the server. The successful browser signer remains covered by spec 25.

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

`bun e2e/capture-terminal-copy.ts` captures the touch actions menu and a native
text selection against the isolated stack. Build the SPA first. It uses a real
shell with sample output and verifies selection and disabled input before
saving the images; it doesn't simulate an iOS copy callout.

For the other documentation screenshots, run `bun e2e/capture-docs.ts` after
building the SPA. It uses the same isolated stack with sample presets, prompts,
a workspace, and real terminal sessions running a small temporary project.
The script also refreshes the six lossless website screenshots using ffmpeg.
No coding-agent responses are simulated. The marketing recordings and README animation come from
`bun e2e/capture-product-demo.ts`, which requires `ffmpeg` and an authenticated
Codex CLI. It records a real interactive agent implementing and testing a feature
in a disposable project, then switches to a test subshell in the same workspace.
It never switches sidebar sections or opens the phone sidebar.
Before changing the recording scenario, read the standing
[website video expectations](../apps/website/AGENTS.md#editorial-expectations).
Review the finished clips against those expectations, not just their encoding
and playback checks.

Review every capture, update intrinsic dimensions in the referring MDX, and check the captions against
the actual controls. The example address and QR code are public sample values;
no setup key is generated. Remove obsolete assets and their references together.

Both screenshot scripts use `screenshot.ts` for a 12px page-colored margin and 2×
pixel density. The helper hides unrelated UI and modal backdrops only during
capture; the photographed controls and their content remain unchanged. Keep
PNG dimensions at native resolution.
The sites supply the same single border around each image, without extra padding.

`bun e2e/capture-preview-intro.ts` captures the loaded marketing site inside a
real, maximized web preview for the documentation overview. Start the website on
port 3401 first. The script uses an isolated test stack and waits for the site's
heading, styles, and image before capturing; it cleans up its subshell and stack.

Two more capture scripts feed the same folder, and both avoid the live server:

`bun e2e/capture-helper-panel.ts` photographs the macOS display helper's consent
panel. It needs the panel built (`bun run --cwd packages/helper-panel build`) and
nothing else: it opens the shipped single-file page over `file://`, the way
`loadFileURL` does, and hands it a state through `window.subshellSetState`, the
same call Swift makes. It draws no control of its own, so the image is the page a
person meets, in the two states that matter (asking for consent, and running with
both required macOS permissions granted).

`bun e2e/capture-assistant-ui.ts` photographs the assistant's **Virtual Displays**
screen. It starts the client UI's own Vite server (port 5177 must be free),
arrives with a Mac user agent because the rail's macOS gate reads it, and answers
the three reads the window makes at that screen (`node_settings` and `node_probe`
from the app's node-state feed, `node_pending_screen` from its mount) with the
facts a configured Mac reports. It teaches one more, `node_about`, which belongs
to the About screen this capture does not open, so the script's stub set is wider
than the photographed page's reads: the stubs are what the window CAN ask, not a
claim about what this screen did. Any command the script has not been taught
answers `null` and is named in the output, so a new read shows up as a gap rather
than a blank corner of a published image. It never presses **Open Display Helper settings**, which would
open a window on the capture host.

`bun e2e/capture-docs.ts` also proves its own preview captures: the header badge
needs a pane that really owns two loopback servers, so the script types the dev
server and the fake CDP endpoint into a terminal pane
(ports 4123 and 9423, the same pair spec 47 uses, deliberately off 9222 where a
developer's real Chromium answers) and waits on `GET /views` until the node
reports them. Both ports are probed before the stack boots, because a leftover
listener from an interrupted run makes the pane's `Bun.serve` die with EADDRINUSE
and the wait would otherwise spend its whole budget on a state it cannot reach.

For the website-preview video and guide images, run
`bun e2e/capture-preview-demo.ts` after building the SPA. It uses a disposable
stack and sample website, records a real authenticated Codex CLI fixing category
filters, and checks those filters through the app proxy before showing a real
Linux virtual display. It requires `ffmpeg`, Xvfb, x11vnc, xauth, and Chrome.
Authentication is copied to a temporary Codex home off camera and removed on
cleanup. `--security-only` skips the agent and display, checking opaque browser
isolation, modules, JSON POST, and WebSocket forwarding instead. Spec 48 runs
those browser checks and immediate delete revocation in CI; spec 47 covers the
enrolled-node proxy and watch handshake. Review the clip at desktop and phone
sizes and keep the three guide image dimensions aligned with the PNG bytes.
