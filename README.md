# Subshell

A web application for creating, viewing, and managing interactive **agent harness sessions**
(Claude Code, OpenCode, Codex, Hermes, Pi). Launch real interactive CLI agents from the
browser, attach/detach via a terminal UI, and terminate them — all local-first.

- **tmux-backed sessions** — sessions survive browser close; attach/detach freely
- **Profiles per harness** — env vars, CLI flags, settings JSON, config-source isolation
- **Plugins** — code-time `HarnessPlugin` interface (claude-code ships with v1)
- **Auth** — better-auth (email/password), first user becomes admin, registration gate
- **Dark-only UI** — xterm 6 terminal, shadcn/ui (Base UI)
- **Single port** — Elysia serves API + WebSocket + built frontend (+ OpenAPI docs)
- **Workspaces** — tile agent sessions side by side; split from any pane's menu, or
  drag a session onto the half of a pane it should take. On a tablet or phone the
  same workspace becomes tabs, one session at a time.
- **Mobile-ready** — iPhone and iPad shells built in: drawer nav, a terminal
  key bar (Esc/Ctrl-C/Enter/arrows), finger-sized workspace panes, and Add to Home
  Screen for a standalone app. No service worker — it always talks to your
  server.
- **Channels** — end-to-end-encrypted cross-session messaging and agent orchestration
  through the bundled `subshell mcp` MCP server (auto-wired into claude-code, opencode
  and codex sessions; hermes and pi register with one copy-pasted command).

## Requirements

- [Bun](https://bun.sh/) >= 1.3
- [tmux](https://github.com/tmux/tmux/wiki) >= 3.2 (backing per-session PTYs)
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

Open http://localhost:5174 — the first visit runs the **setup wizard** (register admin →
pick harness → first profile), then you can create sessions.

## Channels & cross-session orchestration

Sessions boot with a small MCP server (`subshell mcp`, stdio) attached (automatically for
claude-code and opencode; one-time registration for hermes and pi — see below), so
their agent can talk to the other sessions on the instance — and spawn new ones:

- **Encrypted channels** — `post_channel` / `read_channel` and friends. Each
  session holds an ECDH keypair (generated on first run, stored in its data dir);
  messages are sealed per-recipient (ECDH-ES + A256GCM via `jose`). The server only ever
  stores and forwards ciphertext it cannot read.
- **Session CRUD from the agent** — `create_session` (profile + directory + optional
  starter prompt), list/restart/terminate/delete/notes, profiles, channels.
- **Per-session credentials** — starting a session mints a 7-day API key baked into its
  environment; long-running agents self-extend it, and it is revoked the moment the
  session dies or is deleted (auto-restart rotates it).
- **System API keys** — long-lived bearer keys for LAN tooling and admin scripts,
  managed under **Settings → System API keys** (admin, cookie session only; the plaintext
  is shown exactly once).

Each harness is wired in its own dialect, decided by its plugin: **claude-code** gets
the generated file via `--mcp-config`; **opencode** gets a merged config layer pointed
at by `OPENCODE_CONFIG` (your own opencode config stays intact). **hermes** and **pi**
have no per-session config — their profile editor shows the one-time registration
command; after that, every session authenticates through its own baked credentials.
Override how the server is launched with `SUBSHELL_MCP_COMMAND` and `SUBSHELL_MCP_ARGS`
(JSON array) — by default the backend finds its sibling `subshell-mcp` binary (or runs
the TS entry with Bun in dev).

## Production (single port)

```bash
turbo build          # builds frontend/dist + backend/dist
DATABASE_PATH=./data/subshell.db HOST=0.0.0.0 NODE_ENV=production \
  bun run --cwd apps/backend prod
```

The backend serves the built SPA at `/` plus the API, WebSocket and `/docs`.

## Docker

```bash
cp .env.example .env         # set BETTER_AUTH_SECRET (>= 32 chars) + APP_BASE_URL
cp docker/gitconfig.example docker/gitconfig   # your git identity + signing key
mkdir -p ~/.config/subshell
docker compose build
docker compose up -d         # http://localhost:3080
```

- **Data lives in `~/.config/subshell`** (bind-mounted to `/data`: SQLite, session
  logs, channel keypairs). `~/projects` is mounted at its real path, so
  recent/session paths in the DB resolve unchanged. Override either
  with `SUBSHELL_DATA_HOST_DIR=` / `PROJECTS_DIR=` in `.env`.
- **Restarts on boot** via `restart: unless-stopped` — requires the Docker
  daemon itself enabled: `systemctl is-enabled docker || sudo systemctl enable docker`.
- **Port `3080` is published** (not loopback-bound): reverse proxies reach
  this host's IP directly. A `127.0.0.1` bind makes every proxied request 502.
- The harness binary is **not** bundled: the compose file mounts the host's
  `claude` (read-only) plus `~/.claude` / `~/.claude.json` (read-write, where
  claude keeps session records). Adjust those mounts for a different harness.
- Migrating from a host-run dev instance: stop the dev backend (it holds
  `:3080`), then `sqlite3 data/subshell.db ".backup ~/.config/subshell/subshell.db"` and
  `cp -a data/sessions ~/.config/subshell/` from `apps/backend/`. Keep
  `BETTER_AUTH_SECRET` identical and existing browser sessions survive.
- Container restarts end tmux state — running sessions die with the container
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

The service reads the same `.env` and the same data dir (`~/.config/subshell`) as
the Docker deployment — switching over is just `docker compose down`, then
install + start (guard the container against resurrection with a
`restart: "no"` override if you keep the compose files around). `:3080` must
be free, and `.env` must contain no double quotes (systemd `EnvironmentFile`
keeps them literally).

## Configuration

Environment variables (see `apps/backend/src/constants.ts`):

| Var | Default | Purpose |
|---|---|---|
| `SERVER_PORT` | `3080` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `DATABASE_PATH` | `./data/subshell.db` | SQLite file; per-session logs are `data/sessions/`. Ignored under `SUBSHELL_TEST_MODE` |
| `SUBSHELL_TEST_MODE` | unset | Set by the test preload. Forces an in-memory database and a temp log dir, so a test run can never write to real data |
| `APP_BASE_URL` | `http://localhost:$SERVER_PORT` | Auth cookies / redirects; its origin is trusted automatically |
| `TRUSTED_ORIGINS` | `http://localhost:5174,http://localhost:5173` | Comma-separated **additional** allowed origins (dev Vite server). The instance always trusts its own: both loopback spellings of `SERVER_PORT`, plus `HOST` when it is a concrete address |
| `SUBSHELL_MCP_COMMAND` | (sibling `subshell-mcp` binary) | Override how the `subshell mcp` stdio server is launched for a session |
| `SUBSHELL_MCP_ARGS` | `[]` | JSON array of args for `SUBSHELL_MCP_COMMAND` |

Per-session MCP env (injected by the backend into each harness, not set by you):
`SUBSHELL_API_KEY` (the session's bearer token), `SUBSHELL_BASE_URL`, `SUBSHELL_SESSION_ID`,
`SUBSHELL_SESSION_NAME`, `SUBSHELL_DATA_DIR` (where the session's ECDH keypair is persisted).

## Security notes

- Binds loopback by default; Docker compose binds `127.0.0.1` too.
- All `/api/*` (except auth + setup status) requires a session cookie **or** a bearer API
  key (per-session tokens; admin-managed system keys); WS attach requires a short-lived
  single-use token issued by the authenticated REST endpoint. Admin surfaces reject bearer
  keys — management is cookie-session only.
- Channel posts are **end-to-end encrypted**: the server stores opaque ciphertext and
  cannot read message bodies. It *can* still see metadata (who is in a channel, when, and
  message sizes), and it does not defend against a local OS user who can read a session's
  keypair from disk. See `.claude/rules/security-context.md`.
- Harness processes run with a curated env (`env -i`): no app secrets (DB path, auth
  secrets) leak into them. Profile env vars merge on top. A session's bearer token *does*
  reach its harness (that is how it talks as itself); it is scoped and revoked on death.
- PTY output is treated as untrusted: rendered only by xterm, never as HTML.

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
  channels, the `subshell mcp` protocol, session/token choreography, and the invariants
  that hold them together. Start here to work on the backend.
- [Project overview](docs/overview.md) — what Subshell is and the workspace layout.
- Design rationale lives in `docs/superpowers/specs/`; the cross-session build plan in
  `docs/superpowers/plans/`.
- OpenAPI docs at `/docs` (Scalar UI).
- `apps/backend/.env.example` documents the dev env shape.
