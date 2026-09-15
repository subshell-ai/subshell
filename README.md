<div align="center">
  <img src="docs/assets/subshell-wordmark@2x.png" width="640" alt="Subshell" />
</div>

# Subshell

A web application for creating, viewing, and managing interactive **agent harness subshells**
(Claude Code, OpenCode, Codex, Hermes, Pi). Launch real interactive CLI agents from the
browser, attach/detach via a terminal UI, and terminate them — all local-first.

- **tmux-backed subshells** — subshells survive browser close; attach/detach freely
- **Presets per harness** — optional saved launch settings: env vars, CLI flags,
  settings JSON, config-source isolation. A launch needs only an agent and a folder
- **Plugins** — harnesses are packages behind the published `@subshell-ai/plugin-api`
  contract; six ship built in (terminal, claude-code, opencode, codex, hermes, pi),
  installed and disabled instance-wide at Settings → Plugins (admin)
- **Auth** — better-auth (email/password) + passkeys, first user becomes admin,
  registration gate, break-glass recovery password
- **Dark-only UI** — xterm 6 terminal, shadcn/ui (Base UI)
- **Single port** — Elysia serves API + WebSocket + built frontend (+ OpenAPI docs)
- **Workspaces** — tile agent subshells side by side; split from any pane's menu, or
  drag a subshell onto the half of a pane it should take. On a tablet or phone the
  same workspace becomes tabs, one subshell at a time.
- **Mobile-ready** — iPhone and iPad shells built in: drawer nav, a terminal
  key bar (Esc/Ctrl-C/Enter/arrows), finger-sized workspace panes, and Add to Home
  Screen for a standalone app. No service worker — it always talks to your
  server.
- **Channels** — end-to-end-encrypted cross-subshell messaging and agent orchestration
  through the bundled `subshell mcp` MCP server (auto-wired into claude-code, opencode
  and codex subshells; hermes and pi register with one copy-pasted command).
- **Sharing** — a subshell is private to its owner by default; grant **view** (read-only
  live terminal) or **edit** (type, rename, restart) to Everyone or named users. Delete
  and re-sharing stay owner-only, admins included.
- **Nodes** — enrol other machines and launch subshells on them. Commands are
  signed, panes stream back over the same `/ws` the local ones use, and the
  browser cannot tell the difference.
- **Ships as a binary** — `subshell-server` is one self-contained file per platform
  with the SPA embedded: no Bun, no checkout, no separate frontend build.

## Desktop apps

If you would rather not touch a CLI, there are two apps.

**Subshell Server** installs and runs a *control plane* on this machine: a
native window, menu bar and tray, with the server's install, start, stop and
restart behind buttons.

**Subshell Client** is your own way into a control plane — point it at a
server's address and it opens that server's UI in a native window. It is also
where you register *this machine* as a node so agents can be launched on it:
paste a setup key (Settings → Nodes → Add node mints one, single-use and good
for 24 hours) and it enrols, installs the agent as a background service and
shows you its state. A client you only watch subshells from never opens that
half.

**tmux is required, but you no longer need a terminal for it.** Every subshell
runs in a tmux pane, so nothing launches without one. When it is missing the
setup screen says so and installs it with your platform's own package manager:
`brew install tmux` on a Mac that has Homebrew, `pkexec apt-get install tmux`
on Debian/Ubuntu (your desktop prompts for the password). A Mac without
Homebrew gets the MacPorts command to run instead, not a button that could not
work.

| App | macOS (Apple silicon) | Linux (x86_64) |
| --- | --- | --- |
| Subshell Server | `Subshell-Server-Desktop.app.tar.gz` from `desktop-server-vX.Y.Z` | `subshell-server-desktop_X.Y.Z_amd64.deb` |
| Subshell Client | `Subshell-Client-Desktop.app.tar.gz` from `desktop-client-vX.Y.Z` | `subshell-client-desktop_X.Y.Z_amd64.deb` |

macOS builds are signed and notarized and need macOS 13+; the `.deb`s need
Ubuntu 24.04+ / Debian 13+ (glibc 2.39).

Each app ships the binary it manages inside it — nothing is downloaded on first
run. On a machine with nothing installed, Subshell Server opens a setup
assistant: Welcome, Install tmux if it is missing (one button where your
package manager allows it), and Set Up Your Server, one press that installs
the bundled `subshell-server` to `~/.local/bin`, writes a `config.env`,
registers the service (systemd user unit or launchd agent) and starts it,
with port and addresses behind "Customize". The dashboard then opens in the
same window and carries on: your account, agents, and your first subshell.
The console keeps everything it
was for an onboarded machine: state, logs, settings, repair actions. Subshell
Client does the same for the `subshell` agent, from a second window reached
from its tray ("This machine…").

Setup asks two things it used to assume. **Start it in the background** is
what registers a launchd agent or systemd user service; with it unchecked the
app runs the server itself, alive while the app is open and stopped when you
quit (running subshells keep running either way). **Start it at every login**
arms that service for the next login, and is the switch on Settings → Service
afterwards. Changing your mind later is one button on that page, which opens
the app's "How Your Server Runs" screen.

Undoing all of it is deliberately a Settings action, not a window state: the
dashboard's danger zone carries an admin-only "Reset this server" card, which
raises the Subshell Server window at a confirmation listing every path the
reset deletes and arms only after you type this machine's hostname. It stops
the service, closes this machine's panes, deletes the instance data and this
app's choices, and returns you to the wizard — the installed server binary
stays. Details in `apps/server/desktop/AGENTS.md`.

Both apps show the plane's UI in a window loading it from the server's own
address, because that is where the session cookie lives. The window is a plain
webview: it can do nothing to your machine that a browser tab could not.

The two apps can live on one machine, and often should: the machine running the
control plane is usually also one you want to launch agents on.

Two platform differences worth knowing:

- **Closing to the tray is macOS-only.** On Linux, `TrayIconEvent` is never
  emitted and a stock GNOME has no StatusNotifier host, so the icon can be
  silently invisible — hiding a window behind one that may not be there is how
  you lose an app. The setting is not offered there.
- **Passkeys do not work in the app window.** No embedded webview ships a
  platform authenticator. Sign in with your password; a passkey registered in a
  browser still works there.

Intel Macs and arm64 Linux are not built. There is no native arm64 Linux runner
to smoke a GUI on, and Intel Macs are not a target for any component.

## Requirements

- [Bun](https://bun.sh/) >= 1.4
- [tmux](https://github.com/tmux/tmux/wiki) >= 3.2 (backing per-subshell PTYs)
- A harness binary (e.g. `claude` on your PATH) — `packages/pane-runtime` resolves it

The three above are all the server, the web UI and the node agent need. **The
two Tauri desktop apps additionally need a Rust toolchain and, on Linux, the
GTK/WebKit development packages** — see
[`apps/server/desktop/AGENTS.md`](apps/server/desktop/AGENTS.md) ("Native
prerequisites") for the exact list and a check for what is missing. You can
ignore that entirely unless you are building `apps/server/desktop` or
`apps/client/desktop`; nothing in `bun run start`, `bun run test` or
`turbo build` touches cargo.

## Dev

```bash
bun install
bun run start        # turbo watch dev — one command for the whole stack
```

`turbo watch dev` builds the workspace packages (`build:dev`, incremental via
`hash-runner`), then runs both apps and restarts them when a package changes:

- backend — API + WS on `:3080` (`bun --watch`)
- frontend — Vite HMR on `:5174` (proxies `/api` + `/ws` to the backend)

Open http://localhost:5174 — the first visit runs the **setup assistant**: create the admin
account, add an agent (optional, and the screen says what it found on this machine), then
start your first subshell. A launch needs only an agent and a folder — a fresh instance has
no presets, and none are needed to start.

The two Tauri desktop apps are not part of `turbo watch dev` — a `dev` task for them would
open a window on every developer's machine. Each has its own root command, which stages the
~110 MB sidecar the app wraps if this host does not have one yet (a few minutes the first
time, then cached):

```bash
bun run dev:desktop-server   # Subshell Server
bun run dev:desktop-client   # Subshell Client
```

## Channels & cross-subshell orchestration

Subshells boot with a small MCP server (`subshell mcp`, stdio) attached (automatically for
claude-code and opencode; one-time registration for hermes and pi — see below), so
their agent can talk to the other subshells on the instance — and spawn new ones:

- **Encrypted channels** — `post_channel` / `read_channel` and friends. Each
  subshell holds an ECDH keypair (generated on first run, stored in its data dir);
  messages are sealed per-recipient (ECDH-ES + A256GCM via `jose`). The server only ever
  stores and forwards ciphertext it cannot read.
- **Subshell CRUD from the agent** — `create_subshell` (harness + directory, with an
  optional preset, name and starter prompt), list/get/restart/terminate/delete, presets,
  channels — 13 tools in all.
- **Per-subshell credentials** — starting a subshell mints a 7-day API key baked into its
  environment; long-running agents self-extend it, and it is revoked the moment the
  subshell dies or is deleted (auto-restart rotates it).
- **System API keys** — long-lived bearer keys for LAN tooling and admin scripts,
  managed under **Settings → System API keys** (admin, cookie session only; the plaintext
  is shown exactly once).

Each harness is wired in its own dialect, decided by its plugin: **claude-code** gets
the generated file via `--mcp-config`; **opencode** gets a merged config layer pointed
at by `OPENCODE_CONFIG` (your own opencode config stays intact). **hermes** and **pi**
have no per-subshell config — their preset editor shows the one-time registration
command; after that, every subshell authenticates through its own baked credentials.
Override how the server is launched with `SUBSHELL_MCP_COMMAND` and `SUBSHELL_MCP_ARGS`
(JSON array) — by default the backend launches itself (`subshell-server mcp`, or the
TS entry with Bun in dev), falling back to a `subshell` agent on PATH.

## Nodes (running subshells on other machines)

A **node** is another machine that runs harnesses on this instance's behalf. The
control plane keeps the UI, the database and the terminal transport; the node
just executes.

1. **Settings → Nodes → Add node** renders a one-liner carrying a single-use
   setup key (24 h expiry, hashed at rest, revocable).
2. Run it on the target machine. It checks for **tmux** (a node without it
   accepts no launches), downloads the `subshell` agent to `~/.local/bin`,
   verifies the published `.sha256` before the first `chmod +x`, enrols, and
   then asks whether to install a background service that starts at login —
   a systemd user unit on Linux, a launchd agent on macOS. Answer no, or set
   `SUBSHELL_NO_SERVICE=1`, and `subshell service install` does it later.
3. The node appears online. Opening its page (or pressing Re-check) has the
   control plane probe it for the harness binaries this instance offers —
   then launch subshells on it like any other host.

The same three steps are one verb if you already have the binary:
`subshell setup --server <url> --key <nsk_…>`. On Linux, keep the agent alive
across logout with `sudo loginctl enable-linger $USER`; the installer measures
this and says so only when it is missing.

Points worth knowing before you enrol one:

- **Registering a node delegates arbitrary command execution under that
  machine's OS user** to this control plane. Any node share — even `view` — lets
  the grantee launch their own subshells there.
- **The server URL is baked into the install command.** If `APP_BASE_URL` is
  loopback, a remote node dials its own machine; the Add-node dialog shows the
  resolved URL and warns when it is loopback.
- Commands are JWS-signed (authenticity, freshness, target) — *not* encrypted.
  Keep node traffic on the same VPN/Tailscale as everything else, or terminate
  TLS in front.
- The signing keypair at `<data dir>/node-signing.json` rules every enrolled
  node: a control-plane compromise is all nodes.
- An offline node is not a crashed subshell — launches 409 with `NODE_OFFLINE`,
  the reconcile sweep skips its rows, and the UI says "node unreachable".

Architecture detail: [`docs/architecture.md` §9](docs/architecture.md#9-nodes-remote-execution-hosts).
The agent itself: [`apps/node/agent/AGENTS.md`](apps/node/agent/AGENTS.md).

## Headless install (no desktop app)

One command installs the control plane, writes its config, offers to run it in
the background, and tells you where to create the first account:

```bash
curl -fsSL https://raw.githubusercontent.com/subshell-ai/subshell/main/install-server.sh | bash
```

It detects your platform, downloads the matching `subshell-server-cli-<triple>`
from the newest `server-v*` release, **verifies the published `.sha256` before
the first `chmod +x`**, installs to `~/.local/bin/subshell-server`, and runs
`init`. Set `SUBSHELL_SERVER_PORT`, `SUBSHELL_SERVER_HOST`,
`SUBSHELL_SERVER_BASE_URL` or `SUBSHELL_SERVER_TRUSTED_ORIGINS` to answer ahead
of time, and `SUBSHELL_NO_SERVICE=1` to skip the service question.

`init` asks one question — whether to run the server in the background and start
it at login (default yes) — and ends by naming the address to open:

```
Open http://localhost:3080/setup in a browser to create the admin account.
```

**Open it promptly.** The setup endpoints are public until the first account
exists, which is what lets you create it; on a LAN that window is a race, and
it closes the moment someone walks through it.

Then the browser takes over: create the admin account, add an agent CLI, and
start your first subshell.

### Browsing from another machine

The default bind is `0.0.0.0`, so the server is reachable on the LAN — but a
browser's `Origin` still has to be on a **static allowlist**, deliberately not
"whatever host the request claims" (that is the DNS-rebinding hole the list
exists to close). Sign-in from an address the instance does not know answers
**403 "Invalid origin"**, which names nothing on its own. Name the address you
actually browse from:

```bash
subshell-server configure --trusted-origins http://192.168.1.5:3080
subshell-server service restart
```

`init` warns about this at write time when it applies, and the dashboard's
Settings → Service → Addresses card edits the same key later.

### Doing it by hand

```bash
gh release download server-vX.Y.Z -p 'subshell-server-cli-darwin-arm64*'

# The .sha256 sidecar is a BARE 64-hex digest, not `<hash>  <name>`, so
# `shasum -c <file>.sha256` cannot read it — pair the two yourself:
printf '%s  %s\n' "$(cat subshell-server-cli-darwin-arm64.sha256)" \
  subshell-server-cli-darwin-arm64 | shasum -a 256 -c -

install -m755 subshell-server-cli-darwin-arm64 ~/.local/bin/subshell-server

subshell-server init              # config home (0700), auth secret, port/host/db, service
subshell-server status            # what this host WOULD boot with — reads only
```

The control plane ships as one self-contained binary per platform with the SPA
embedded — no Bun, no checkout, no `apps/server/web/dist` on the host. Assets
live on GitHub Releases under `server-vX.Y.Z` as `subshell-server-cli-<triple>`
(`linux-x64`, `linux-arm64`, `darwin-arm64`; darwin builds are signed and
notarized) and under `node-vX.Y.Z` as `subshell-node-cli-<triple>` for the node
agent. The `cli` in an asset name says it is the bare binary rather than the
desktop app that wraps it; you rename it to `subshell-server` (or `subshell`) on
install, as above.

`status` is the first thing to run when something looks wrong: it prints the
config.env path, the layer each setting came from (masking the secret), tmux
presence, the resolved MCP entrypoint and which rung answered, port liveness,
whether a service definition is on disk, and **whether the admin account has
been created yet**. Config lives in `~/.config/subshell-server/config.env`
(0600); precedence is **process env > config.env > `.env` > built-in defaults**.

### Running it as a service

`init` offers this, and it is also a verb of its own — a systemd **user** service
on Linux, a launchd agent on macOS. No sudo is involved:

```bash
subshell-server service install    # write + enable the unit / agent
subshell-server service status     # what the manager reports (--json for scripts)
subshell-server service start|stop|restart
subshell-server service enable|disable   # start at login, without touching the running process
subshell-server service uninstall
```

On Linux a user service dies at logout unless the account lingers, which is the
difference between "comes back when you log in" and "comes back after a reboot
with nobody logged in". The installer measures it and prints the fix only when
it is missing:

```bash
sudo loginctl enable-linger $USER
```

Settings → Service says the same thing in the dashboard, so a headless host can
be checked from a browser later.

From a checkout, the same CLI is the entry point — `src/index.ts` is both the
boot entry and the CLI, and the generated unit records the interpreter plus the
resolved script path:

```bash
bunx turbo build
bun apps/server/api/src/index.ts init
bun apps/server/api/src/index.ts service install
```

Cutting a release is a workflow dispatch, never a hand-made tag —
`gh workflow run release.yml -f app=all`. See root
[`AGENTS.md`](AGENTS.md) for the full pipeline.

## Production (single port)

```bash
turbo build          # builds frontend/dist + server/dist
DATABASE_PATH=./data/subshell.db HOST=0.0.0.0 NODE_ENV=production \
  APP_BASE_URL=https://subshell.example.com \
  BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  bun run --cwd apps/server/api prod
```

The backend serves the built SPA at `/` plus the API, WebSocket and `/docs`.

Three things this form needs that a desktop or `init`-provisioned install gets
for free:

- **`BETTER_AUTH_SECRET` is mandatory here.** `NODE_ENV=production` refuses to
  boot on the built-in placeholder. `init` generates one; a hand-rolled
  deployment that skips `init` has to supply it, and must keep the SAME value
  across restarts or every session is invalidated.
- **`APP_BASE_URL` is the address you browse**, and it is also better-auth's
  passkey rpID — so changing it later stops existing passkeys working on the
  old address. Add any OTHER name a browser uses to `TRUSTED_ORIGINS`, or
  sign-in answers 403 "Invalid origin".
- **A hand-run server cannot restart itself.** The dashboard's Restart button
  requires the service manager to report *this* pid, which a bare `bun run` or
  a container never satisfies; it stays greyed out by design. Everything else
  on Settings → Service works.

## Docker

```bash
cp .env.example .env         # set BETTER_AUTH_SECRET (>= 32 chars) + APP_BASE_URL
cp docker/gitconfig.example docker/gitconfig   # your git identity + signing key
mkdir -p ~/.config/subshell-server
docker compose build
docker compose up -d         # http://localhost:3080
```

- **Data lives in `~/.config/subshell-server`** (bind-mounted to `/data`: SQLite, subshell
  logs, channel keypairs). `~/projects` is mounted at its real path, so
  recent/subshell paths in the DB resolve unchanged. Override either
  with `SUBSHELL_DATA_HOST_DIR=` / `PROJECTS_DIR=` in `.env`.
- **Restarts on boot** via `restart: unless-stopped` — requires the Docker
  daemon itself enabled: `systemctl is-enabled docker || sudo systemctl enable docker`.
- **Port `3080` is published** (not loopback-bound): reverse proxies reach
  this host's IP directly. A `127.0.0.1` bind makes every proxied request 502.
- The harness binary is **not** bundled: the compose file mounts the host's
  `claude` (read-only) plus `~/.claude` / `~/.claude.json` (read-write, where
  claude keeps session records). Adjust those mounts for a different harness.
- Migrating from a host-run dev instance: stop the dev backend (it holds
  `:3080`), then `sqlite3 data/subshell.db ".backup ~/.config/subshell-server/subshell.db"` and
  `cp -a data/subshells ~/.config/subshell-server/` from `apps/server/api/`. Keep
  `BETTER_AUTH_SECRET` identical and existing browser sessions survive.
- Container restarts end tmux state — running subshells die with the container
  and surface as dead rows; restart them from the UI.
- **Git push works from panes**: the host's `~/.ssh` is mounted read-only and
  `docker/gitconfig` (from the copied example) supplies the commit identity
  with ssh-format signing via stock `ssh-keygen` — the signer's `.pub`
  companion must exist in `~/.ssh`. Keys are therefore readable by any
  harness pane — trusted-host posture. New git hosts need `ssh-keyscan` on
  the host first.
- **Extra host mounts** (e.g. `~/.config/gh`): put them in
  `docker-compose.override.yaml` beside the base file — gitignored and merged
  automatically by `docker compose`, no base-file edits required.

### Host service (no Docker)

Running the control plane as a systemd **user** service or launchd agent is
covered under [Headless install](#running-it-as-a-service) — the panes then get
native host tools instead of a container's package set. What follows is the part
that only matters once one is installed.

`systemctl --user` / `launchctl` still work if you prefer them, with one caveat
that is the reason the CLI verbs exist: each local subshell's tmux server is a
**child** of the service, so a definition written before 2026-09-03 takes every
running subshell down with it — on **stop** as much as on restart, since a
restart is a stop followed by a start. The CLI is the only thing that says so.
`service restart` refuses on such a host (`--force` overrides), `service stop`
warns and proceeds, and `service status` reports the fact up front as `teardown
keeps panes`. A bare `systemctl --user stop` tells you nothing.

On Linux the check asks systemd for the **effective** `KillMode`, so a drop-in
under `subshell-server.service.d/` is seen; on macOS it reads
`AbandonProcessGroup` out of the plist with `plutil`.

Configuration lives in `~/.config/subshell-server/config.env` (0600), which the
unit loads as its `EnvironmentFile` — the binary's own loader reads the same
file, so the two cannot disagree. `:3080` must be free.

> **Upgrading from `svc.sh`.** Earlier versions shipped a `svc.sh` script that
> wrote the *same* unit name from the repo's `.env` instead. It has been
> removed: two installers owning one unit path from two different config
> sources is a footgun, and the CLI covers the from-a-checkout case it existed
> for. To cut over, move the values from the repo `.env` into `config.env`
> (`init` adopts an existing `BETTER_AUTH_SECRET`; carry across anything beyond
> the four keys `configure` owns), then reinstall:
>
> ```bash
> systemctl --user disable --now subshell-server.service
> rm ~/.config/systemd/user/subshell-server.service
> bun apps/server/api/src/index.ts init && bun apps/server/api/src/index.ts service install
> ```
>
> Both installers write `KillMode=process`, so a restart does not take live
> panes down with it — verify with
> `systemctl --user show subshell-server.service -p KillMode`.

## Configuration

Environment variables (see `apps/server/api/src/constants.ts`):

| Var | Default | Purpose |
|---|---|---|
| `SERVER_PORT` | `3080` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `DATABASE_PATH` | `./data/subshell.db` | SQLite file; per-subshell logs are `data/subshells/`. Ignored under `SUBSHELL_TEST_MODE` |
| `SUBSHELL_TEST_MODE` | unset | Set by the test preload. Forces a per-process temp-file database (unlinked on exit) and a temp log dir, so a test run can never write to real data |
| `APP_BASE_URL` | `http://localhost:$SERVER_PORT` | Auth cookies / redirects; its origin is trusted automatically |
| `TRUSTED_ORIGINS` | `http://localhost:5174,http://localhost:5173` | Comma-separated **additional** allowed origins (dev Vite server). The instance always trusts its own: both loopback spellings of `SERVER_PORT`, plus `HOST` when it is a concrete address |
| `SUBSHELL_MCP_COMMAND` | (self: `subshell-server mcp`, else `subshell` on PATH) | Override how the `subshell mcp` stdio server is launched for a subshell |
| `SUBSHELL_MCP_ARGS` | `[]` | JSON array of args for `SUBSHELL_MCP_COMMAND` |
| `BETTER_AUTH_SECRET` | a placeholder | Auth signing secret. `NODE_ENV=production` **refuses to boot** on the placeholder — set >= 32 real chars before binding beyond loopback |
| `SUBSHELL_SERVER_DATA_DIR` | `dirname(DATABASE_PATH)` | Pane logs/meta, channel identities, `node-signing.json`, `vapid.json`, node artifacts. Point it somewhere real before first boot — the control plane lazily re-mints its signing and push keys if it lands on an empty dir, which un-enrols every node |
| `SUBSHELL_NODE_ARTIFACTS_DIR` | `<data dir>/node-artifacts` | Where prebuilt `subshell` agent binaries are published and served from |
| `SUBSHELL_EMERGENCY_PASSWORD` | unset | Break-glass: while set, an admin signing in with this exact value has their password **overwritten** by it. Every signed-in user sees a warning banner. Clear it after recovery |
| `BACKEND_LOG_LEVEL` | `debug` | LogLayer level for the server |
| `SUBSHELL_TERMINAL_REPLAY_LINES` | `100` | Lines of scrollback replayed on terminal attach |
| `SUBSHELL_ATTACH_DEBUG` | unset | `1` dumps pre-resize/replay pane contents to `/tmp/subshell-attach-debug/`. **Off by default — the dumps are real screen contents and can contain secrets** |
| `SUBSHELL_CHANNEL_PIN` | strict | Channel peer-key TOFU pinning (read by `subshell mcp`, not the server). Only `trust` opts out |

Per-subshell MCP env (injected by the backend into each harness, not set by you):
`SUBSHELL_API_KEY` (the subshell's bearer token), `SUBSHELL_BASE_URL`, `SUBSHELL_ID`,
`SUBSHELL_NAME`, `SUBSHELL_DATA_DIR` (where the subshell's ECDH keypair is persisted).

## Security notes

Summary only — the full threat model, including what is deliberately *not*
defended against, is **[docs/security.md](docs/security.md)**.

- Binds all interfaces (`0.0.0.0`) by default — remote nodes and devices cannot reach a loopback
  socket; set `HOST=127.0.0.1` to stay loopback-only. Docker compose binds `127.0.0.1`.
- All `/api/*` (except auth + setup status) requires a session cookie **or** a bearer API
  key (per-subshell tokens; admin-managed system keys); WS attach requires a short-lived
  single-use token issued by the authenticated REST endpoint. Admin surfaces reject bearer
  keys — management is cookie-session only.
- Channel posts are **end-to-end encrypted**: the server stores opaque ciphertext and
  cannot read message bodies. It *can* still see metadata (who is in a channel, when, and
  message sizes), and it does not defend against a local OS user who can read a subshell's
  keypair from disk. See `.claude/rules/security-context.md`.
- Harness processes run with a curated env (`env -i`): no app secrets (DB path, auth
  secrets) leak into them. Preset env vars merge on top. A subshell's bearer token *does*
  reach its harness (that is how it talks as itself); it is scoped and revoked on death.
- PTY output is treated as untrusted: rendered only by xterm, never as HTML.
- **Sharing widens exposure deliberately.** A `view` grant shows the grantee everything on
  the pane (secrets on screen included); `edit` also hands them the keystroke stream.
  Everyone attached to a shared subshell also sees every other attached device's chosen
  name. Revoke by clearing the grant.
- **Enrolling a node** delegates command execution under that machine's OS user to this
  control plane, and puts each subshell's bearer token in that host's `ps` output. The
  command-signing keypair on the backend host rules every enrolled node.

## Remote / trusted-network operation

For operating Subshell from a machine that is not the box (e.g. from a laptop over
your VPN):

- Bind `HOST=0.0.0.0` and set `APP_BASE_URL=https://<your-vpn-host>` — that
  origin is trusted automatically. Add `TRUSTED_ORIGINS` (comma-separated) for
  any extra names you serve under. (`HOST=<concrete address>` self-trusts its
  own `http://<host>:<port>` origin; `0.0.0.0` is a listen address, not one.)
- Recommended: keep it behind WireGuard / Tailscale / an SSH tunnel. The
  service is hardened for trusted networks (rate-limited login, per-user
  accounts, audit trail) but is **NOT internet-grade** — no TLS enforcement,
  no 2FA; see `.claude/rules/security-context.md` for the intended threat
  model.
- `GET /api/audit?limit=50` (admin) lists audit events.
- Phones/tablets: open the same URL in Safari and use **Add to Home Screen**
  for a standalone install (no browser chrome).

## Docs / API

- **[Architecture reference](docs/architecture.md)** — processes, credentials, encrypted
  channels, the `subshell mcp` protocol, subshell/token choreography, and the invariants
  that hold them together. Start here to work on the backend.
- **[Security model](docs/security.md)** — the threat model: what is defended,
  what explicitly is not, the credential and authorization rules, and the
  checklist that would have to be worked through before exposing this beyond a
  trusted network. Read it before enrolling a node or sharing a subshell.
- [Node protocol](docs/node-protocol.md) — the control-plane ↔ agent wire
  contract: enrollment, the two version gates, the signed command envelope and
  its replay defense, every command and event.
- [Project overview](docs/overview.md) — what Subshell is, the workspace layout, and
  what has shipped.
- Per-app notes — the tree under `apps/` is grouped by the three words the
  product uses (a **server** is a control plane, a **node** is a machine that
  runs agents, a **client** is a person's interface to a control plane):
  [`apps/server/api`](apps/server/api/AGENTS.md)
  (routes, the CLI/binary, attach diagnostics),
  [`apps/server/web`](apps/server/web/AGENTS.md) (the SPA the server serves),
  [`apps/server/desktop`](apps/server/desktop/AGENTS.md) (its Tauri GUI),
  [`apps/node/agent`](apps/node/agent/AGENTS.md) (the node agent),
  [`apps/client/desktop`](apps/client/desktop/AGENTS.md) (its Tauri GUI),
  [`apps/client/mobile`](apps/client/mobile/AGENTS.md), [`e2e`](e2e/AGENTS.md).
- Build, release and migration operations: root [`AGENTS.md`](AGENTS.md).
- Design rationale lives in `docs/superpowers/specs/`; the build plans in
  `docs/superpowers/plans/`.
- OpenAPI docs at `/docs` (Scalar UI).
- `apps/server/api/.env.example` documents the dev env shape.

## License

Subshell is dual-licensed, and the line is the directory tree:

| path | license |
|---|---|
| `apps/server/**` — the control plane (API, the SPA it serves, its desktop app) | **AGPL-3.0-only** |
| everything else — the `subshell` node agent, the client apps, every shared package and crate | **Apache-2.0** |

**Self-hosting Subshell is free.** No time limit, no user cap, no feature clock,
no license key. That is not a trial — it is the deal, and it is written into
both licenses and into the [CLA](CLA.md).

The permissive half is permissive on purpose: write harness plugins, embed the
node agent, and build tools on the subshell protocol without inheriting
copyleft. The AGPL covers only the piece someone would fork into a competing
hosted service — if you run a modified control plane as a network service, you
owe your users its source.

**Building an API client is not copyleft either.** `apps/server/LICENSE` carries
an additional permission under AGPL section 7 — the *API Type Surface
exception* — letting you use the control plane's TypeScript type declarations
(routes, request/response shapes, WebSocket frames, MCP tools, the exported
`App` type, and any `.d.ts` generated from them) under Apache-2.0 rather than
the AGPL. Only the implementation is copyleft. So an SDK, a CLI, a bot or a
dashboard built against Subshell's API carries no AGPL obligation, however you
ship it.

Contributions require a one-time [Contributor License Agreement](CLA.md). You
keep the copyright in your work; the CLA grants the right to license it, which
is what lets the server stay AGPL while non-AGPL commercial licenses remain
available to organizations whose policies forbid the AGPL.

**Commercial licensing.** Subshell is copyright Disaresta, LLC. If your organization
cannot use AGPL-licensed software, non-AGPL commercial licenses for the control
plane are available — contact Theo Gravity <theo@disaresta.com>.

Full text: [`LICENSE`](LICENSE) (Apache-2.0) and
[`apps/server/LICENSE`](apps/server/LICENSE) (AGPL-3.0).
