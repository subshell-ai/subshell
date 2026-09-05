<div align="center">
  <img src="docs/assets/subshell-wordmark@2x.png" width="640" alt="Subshell" />
</div>

# Subshell

A web application for creating, viewing, and managing interactive **agent harness subshells**
(Claude Code, OpenCode, Codex, Hermes, Pi). Launch real interactive CLI agents from the
browser, attach/detach via a terminal UI, and terminate them — all local-first.

- **tmux-backed subshells** — subshells survive browser close; attach/detach freely
- **Profiles per harness** — env vars, CLI flags, settings JSON, config-source isolation
- **Plugins** — code-time `HarnessPlugin` interface; five ship (claude-code, opencode,
  codex, hermes, pi)
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

## Requirements

- [Bun](https://bun.sh/) >= 1.4
- [tmux](https://github.com/tmux/tmux/wiki) >= 3.2 (backing per-subshell PTYs)
- A harness binary (e.g. `claude` on your PATH) — `packages/harnesses` resolves it

## Dev

```bash
bun install
bun run start        # turbo watch dev — one command for the whole stack
```

`turbo watch dev` builds the workspace packages (`build:dev`, incremental via
`hash-runner`), then runs both apps and restarts them when a package changes:

- backend — API + WS on `:3080` (`bun --watch`)
- frontend — Vite HMR on `:5174` (proxies `/api` + `/ws` to the backend)

Open http://localhost:5174 — the first visit runs the **setup wizard** (two steps: register
admin → enable a harness), then you can create subshells. Enabling a harness auto-seeds a
blank **Default** profile, so there is no profile step to complete.

## Channels & cross-subshell orchestration

Subshells boot with a small MCP server (`subshell mcp`, stdio) attached (automatically for
claude-code and opencode; one-time registration for hermes and pi — see below), so
their agent can talk to the other subshells on the instance — and spawn new ones:

- **Encrypted channels** — `post_channel` / `read_channel` and friends. Each
  subshell holds an ECDH keypair (generated on first run, stored in its data dir);
  messages are sealed per-recipient (ECDH-ES + A256GCM via `jose`). The server only ever
  stores and forwards ciphertext it cannot read.
- **Subshell CRUD from the agent** — `create_subshell` (profile + directory + optional
  starter prompt), list/get/restart/terminate/delete, profiles, channels — 13 tools in all.
- **Per-subshell credentials** — starting a subshell mints a 7-day API key baked into its
  environment; long-running agents self-extend it, and it is revoked the moment the
  subshell dies or is deleted (auto-restart rotates it).
- **System API keys** — long-lived bearer keys for LAN tooling and admin scripts,
  managed under **Settings → System API keys** (admin, cookie session only; the plaintext
  is shown exactly once).

Each harness is wired in its own dialect, decided by its plugin: **claude-code** gets
the generated file via `--mcp-config`; **opencode** gets a merged config layer pointed
at by `OPENCODE_CONFIG` (your own opencode config stays intact). **hermes** and **pi**
have no per-subshell config — their profile editor shows the one-time registration
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
2. Run it on the target machine. It downloads the `subshell` agent, verifies the
   published `.sha256` before the first `chmod +x`, enrols, and can install
   itself as a background service (`subshell service install` — systemd user
   unit on Linux, launchd agent on macOS).
3. The node appears online with its harness inventory. Launch subshells on it
   like any other host.

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
The agent itself: [`apps/client/AGENTS.md`](apps/client/AGENTS.md).

## Install from a release binary

The control plane ships as one self-contained binary per platform, with the SPA
embedded — no Bun, no checkout, no `apps/frontend/dist` on the host. Assets live
on GitHub Releases under `server-vX.Y.Z` (`linux-x64`, `linux-arm64`,
`darwin-arm64`; darwin builds are signed and notarized) and `client-vX.Y.Z` for
the node agent (`linux|darwin × x64|arm64`).

```bash
gh release download server-v1.6.0 -p 'subshell-server-darwin-arm64*'
shasum -a 256 -c subshell-server-darwin-arm64.sha256
install -m755 subshell-server-darwin-arm64 ~/.local/bin/subshell-server

subshell-server init              # config home (0700), auth secret, port/host/db
subshell-server service install   # systemd user unit / launchd agent
subshell-server status            # what this host WOULD boot with — reads only
```

`status` is the first thing to run when something looks wrong: it prints the
config.env path, the layer each setting came from (masking the secret), tmux
presence, the resolved MCP entrypoint and which rung answered, port liveness,
and whether a service definition is on disk. Config lives in
`~/.config/subshell-server/config.env` (0600); precedence is **process env >
config.env > `.env` > built-in defaults**.

Cutting a release is a workflow dispatch, never a hand-made tag —
`gh workflow run release.yml -f app=both`. See root
[`AGENTS.md`](AGENTS.md) for the full pipeline.

## Production (single port)

```bash
turbo build          # builds frontend/dist + server/dist
DATABASE_PATH=./data/subshell.db HOST=0.0.0.0 NODE_ENV=production \
  bun run --cwd apps/server prod
```

The backend serves the built SPA at `/` plus the API, WebSocket and `/docs`.

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
  `cp -a data/subshells ~/.config/subshell-server/` from `apps/server/`. Keep
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

`svc.sh` (repo root) runs subshell as a systemd **user** service at boot — the
panes then get native host tools instead of the image's package set. No sudo
is involved; the one-time `sudo loginctl enable-linger $USER` (so user
services start without a login) is checked for you.

```bash
turbo build            # fresh dist artifacts (prerequisite of install)
./svc.sh install       # generate ~/.config/systemd/user/subshell-server.service + enable
./svc.sh start         # stop / restart / status / uninstall also exist
```

The service reads the same `.env` and the same data dir (`~/.config/subshell-server`) as
the Docker deployment — switching over is just `docker compose down`, then
install + start (guard the container against resurrection with a
`restart: "no"` override if you keep the compose files around). `:3080` must
be free, and `.env` must contain no double quotes (systemd `EnvironmentFile`
keeps them literally).

## Configuration

Environment variables (see `apps/server/src/constants.ts`):

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

- Binds loopback by default; Docker compose binds `127.0.0.1` too.
- All `/api/*` (except auth + setup status) requires a session cookie **or** a bearer API
  key (per-subshell tokens; admin-managed system keys); WS attach requires a short-lived
  single-use token issued by the authenticated REST endpoint. Admin surfaces reject bearer
  keys — management is cookie-session only.
- Channel posts are **end-to-end encrypted**: the server stores opaque ciphertext and
  cannot read message bodies. It *can* still see metadata (who is in a channel, when, and
  message sizes), and it does not defend against a local OS user who can read a subshell's
  keypair from disk. See `.claude/rules/security-context.md`.
- Harness processes run with a curated env (`env -i`): no app secrets (DB path, auth
  secrets) leak into them. Profile env vars merge on top. A subshell's bearer token *does*
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
- Per-app notes: [`apps/server`](apps/server/AGENTS.md) (routes, the CLI/binary, attach
  diagnostics), [`apps/frontend`](apps/frontend/AGENTS.md),
  [`apps/client`](apps/client/AGENTS.md) (the node agent),
  [`apps/mobile`](apps/mobile/AGENTS.md), [`e2e`](e2e/AGENTS.md).
- Build, release and migration operations: root [`AGENTS.md`](AGENTS.md).
- Design rationale lives in `docs/superpowers/specs/`; the build plans in
  `docs/superpowers/plans/`.
- OpenAPI docs at `/docs` (Scalar UI).
- `apps/server/.env.example` documents the dev env shape.
