# syntax=docker/dockerfile:1

# Mote — agent harness manager
#
# Multi-stage build: stage 1 installs deps + builds all workspace packages,
# stage 2 is a slim runtime with tmux. The app serves API + WS + built
# frontend on a single port (default 127.0.0.1:3080).

FROM oven/bun:1.4 AS base
WORKDIR /app

# ---- Dependencies (workspace manifests only, for layer caching) ----
# The list must cover every workspace the root package.json globs
# (apps/*, packages/*, e2e) — `--frozen-lockfile` fails on a missing one.
FROM base AS deps
COPY package.json bun.lock turbo.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
COPY e2e/package.json e2e/
COPY packages/harnesses/package.json packages/harnesses/
COPY packages/session-protocol/package.json packages/session-protocol/
COPY packages/backend-client/package.json packages/backend-client/
COPY packages/backend-errors/package.json packages/backend-errors/
COPY packages/tsconfig/package.json packages/tsconfig/
# --ignore-scripts: bun would run the root `prepare` (lefthook install) here —
# dev tooling that needs git and a .git dir, neither of which exists in the
# image (dependency lifecycle scripts are not affected by this flag in bun).
RUN bun install --frozen-lockfile --ignore-scripts

# ---- Build all workspace code ----
FROM deps AS build
COPY . .
# Workspace packages must build first (backend imports their dist output).
RUN bun run --cwd packages/session-protocol build \
 && bun run --cwd packages/harnesses build \
 && bun run --cwd packages/backend-errors build \
 && bun run --cwd packages/backend-client build \
 && bun run --cwd apps/frontend build \
 && bun run --cwd apps/backend build

# ---- Runtime (slim) ----
FROM oven/bun:1.4-slim AS runtime
WORKDIR /app

# tmux backs sessions (per-session socket, pipe-pane streaming); git is what
# the harnesses run against the mounted projects; openssh-client provides
# ssh (for git push over ssh remotes with the mounted ~/.ssh) and ssh-keygen
# (for git's ssh-format commit signing).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Non-root by default. Compose normally overrides `user:` with the host uid,
# so /home/mote and /data are world-writable; HOME is pinned because the
# numeric host uid has no passwd entry of its own and the claude CLI writes
# under $HOME. When the host uid IS in passwd (1000 = the base image's `bun`
# user) its home is repointed at /home/mote too — ssh resolves ~/.ssh and
# ssh_config via the passwd entry, not $HOME, so a mismatch there silently
# defeats the mounted keys.
RUN useradd --create-home --uid 1001 mote \
 && usermod -d /home/mote bun \
 && mkdir -p /data /home/mote \
 && chown mote:mote /data /home/mote \
 && chmod 777 /data /home/mote
ENV HOME=/home/mote
USER mote

# Install production deps from the same manifest snapshot as the build stage
# (this recreates the full bun workspace layout — including the top-level
# @internal/* and hoisted symlinks that bun's installer creates — which a
# COPY of node_modules breaks). Runs as root, then drops to `mote`.
COPY --from=deps /app/. ./

# Built artifacts (backend imports @internal/* from the workspace root).
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/apps/frontend/dist ./apps/frontend/dist
COPY --from=build /app/packages ./packages

# SQLite + session logs live here (mount a volume).
ENV DATABASE_PATH=/data/mote.db
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 3080

CMD ["bun", "run", "./apps/backend/dist/index.js"]
