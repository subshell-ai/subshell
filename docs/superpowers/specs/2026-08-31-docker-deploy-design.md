# Docker deployment — design

Date: 2026-08-31
Status: approved (Theo: "good to go, execute")

## Goal

Run mote as a production container that starts at boot, serves
`https://mote.ein.disaresta.com` (NetBird proxy target moves from the Vite dev
server `:5174` to the container `:3080`), and continues the existing data —
accounts, bookmarks, recent paths, session history — from bind mounts at
`~/.config/mote` (app data) and `~/projects` (session working dirs).

The repo already ships a `Dockerfile` + `docker-compose.yaml` (README §Docker),
but they are stale: the Dockerfile copies the removed `packages/sqlite-dialect`
manifest and omits `packages/session-protocol` and the `e2e` workspace (so
`bun install --frozen-lockfile` fails), pins Bun 1.3.14 below the repo's
`>=1.4.0` engine floor, and the compose layout (named volume, `/workspace`
mount point, nonexistent `~/.config/claude` source) does not match this
machine's paths. Approach chosen: **repair in place** — deployment config stays
next to the code it packages.

## Image (`Dockerfile`)

- Multi-stage stays: `oven/bun` deps+build → `-slim` runtime.
- Bun `1.3.14` → `1.4` (both stages), matching the repo engine floor.
- deps stage manifest copies: drop `packages/sqlite-dialect`, add
  `packages/session-protocol` and `e2e` (the root workspaces glob requires it).
- build stage: build `session-protocol` (deps order), drop `sqlite-dialect`.
- runtime apt set: `tmux`, `git`, `ca-certificates`.
- `ENV HOME=/home/mote`; create that dir — compose runs as the host uid, and
  the claude CLI writes under `$HOME`.
- `mote mcp` needs nothing extra: the launcher's prod fallback resolves
  `dist/mcp/main.js` next to the entrypoint.
- Env defaults: `DATABASE_PATH=/data/mote.db`, `HOST=0.0.0.0`,
  `NODE_ENV=production`. `CMD` unchanged.

## Compose (`docker-compose.yaml`)

- `user: "${UID:-1000}:${GID:-1000}"` — host uid keeps bind ownership coherent.
- `ports: "3080:3080"` — published (not loopback-only): the NetBird proxy
  connects to this host's reachable IP, which is exactly what loopback broke.
- `restart: unless-stopped` — starts with the Docker daemon at boot.
- Volumes:
  - `${MOTE_DATA_DIR:-$HOME/.config/mote}:/data` — SQLite, session logs,
    channel keypairs (replaces the `mote-data` named volume; no chown fixup
    needed since binds carry the host uid).
  - `${PROJECTS_DIR:-$HOME/projects}:${PROJECTS_DIR:-$HOME/projects}:rw` —
    same path inside; migrated bookmarks/recent/session paths resolve as-is.
  - `${CLAUDE_BIN:-$HOME/.local/bin/claude}:/usr/local/bin/claude:ro`.
  - `${HOME}/.claude:${HOME}/.claude:rw` and `${HOME}/.claude.json:...:rw` —
    claude keeps writing session records there; same-uid sharing matches
    running the CLI natively.
  - Dropped: `~/work-items`, `~/.config/claude` (source does not exist),
    `/workspace` (replaced by the same-path mount).
- Environment:
  - `APP_BASE_URL=${APP_BASE_URL:-https://mote.ein.disaresta.com}` — trusted
    origin derives from it automatically.
  - `BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:?...}` — required; supplied by
    the gitignored `.env` beside the compose file, set to the SAME value as
    `apps/backend/.env` so existing browser sessions stay valid after cutover.
  - `NODE_ENV=production`.

## Cutover runbook (documented in README)

1. `mkdir -p ~/.config/mote`; stop whatever holds `:3080` (the dev backend).
2. Copy data while quiescent: sqlite backup of `apps/backend/data/mote.db` →
   `~/.config/mote/mote.db`; `cp -a apps/backend/data/sessions` likewise.
3. `docker compose build && docker compose up -d`; smoke: `curl -s localhost:3080`.
4. Flip the NetBird proxy target `:5174 → :3080`.
5. Boot: `systemctl is-enabled docker || sudo systemctl enable docker`.

## Known behaviors (documented, not fixed)

- Container restart destroys tmux state: running sessions die with it; rows
  surface as dead and are restarted from the UI.
- WebSocket still cannot cross the NetBird service proxy (terminal panes need
  direct `:3080` access, e.g. from a NetBird-joined machine).
- Dev flow keeps working: Vite proxies `127.0.0.1:3080`, which is now the
  container. The dev backend and the container cannot both own `:3080`; when
  running both, dev moves to another `SERVER_PORT`, and until then dev and
  prod DBs (`apps/backend/data` vs `~/.config/mote`) diverge deliberately.

## Out of scope

opencode mounts, CI image publishing, in-container TLS (NetBird terminates),
compose-driven e2e runs.
