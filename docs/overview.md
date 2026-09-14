# Subshell — Project Overview

**Subshell** is a web application for creating, viewing, and managing interactive **agent harness
subshells** — real CLI coding agents (Claude Code, opencode, codex, hermes, pi) that you
launch from the browser, attach/detach via a terminal UI, and terminate. It's **local-first**:
subshells spawn as tmux-backed PTYs on the machine running the app; Docker is secondary.

> This page is the quick orientation. The full system design — credential model,
> encrypted-channel protocol, the `subshell mcp` contract, subshell/token choreography and the
> invariants that bind them — lives in the **[architecture reference](architecture.md)**,
> which is authoritative when anything here disagrees with it. Two areas have
> their own references: **[security.md](security.md)** (threat model) and
> **[node-protocol.md](node-protocol.md)** (the control-plane ↔ agent wire).

## Architecture

```
browser ──•── /                   Elysia serves built frontend (SPA)
          │                       + API + WS + auth on ONE port (default 0.0.0.0:3080)
          ├─ /api/...             REST/JSON (better-auth at /api/auth/*)
          ├─ /ws                  subshell attach WebSocket (?subshell=&token=)
          └─ /docs                OpenAPI (Scalar UI)
               │
               └─ spawns ──► tmux server (per-subshell socket: subshell-<sha1[:12]>)
                              └──► claude / harness (in PTY, env -i curated env)
                                    └──► `subshell mcp` (stdio MCP server, registered in
                                         the harness's own dialect — see arch §4)
                                         └── talks back over /api as the subshell's
                                             bearer token (channels + subshell CRUD)
```

### Key decisions

| Area | Choice |
|---|---|
| Runtime | **Bun** exclusively (monorepo via turbo workspaces) |
| Database | **SQLite via `bun:sqlite`** — no native-module deps; Kysely `Dialect` from `kysely-bun-sqlite-dialect`. Every handle opens through `apps/server/api/src/db/open-database.ts`, which applies `PRAGMA foreign_keys = ON` — the `workspace_panes` cascades depend on it |
| Subshells | **tmux-backed, detachable** (survive browser close; tmux >= 3.2, per README); pipe-pane → per-subshell log file. tmux 3.6 additionally exposes `#{pane_dead_status}`, which is how a crashed pane's exit code is read — on older tmux that read degrades to `null`, never to an error |
| Auth | **better-auth** (email/password); HttpOnly cookie; first user becomes admin; registration gate. Signed-out visitors are guarded to a chrome-free `/login` (first run goes to `/setup` instead). The user roster is instance-wide **read-only**; management (create, audit) is cookie-admin-only. Machine paths: bearer API keys via `@better-auth/api-key` — per-subshell tokens (revoked on death) + admin-managed system keys; admin surfaces are cookie-only |
| Cross-subshell comms | **E2EE channels + `subshell mcp`**: durable append-only log (no queue), per-recipient sealed envelopes (jose, ECDH-ES+A256GCM) the server cannot read; cursor reads with long-poll; agents manage subshells/channels through 13 MCP tools (6 channel, 7 subshell) |
| Terminal | **xterm 6** (fit/webgl/serialize/search addons); dark-only shadcn/ui (Base UI) theme — the old Radix tree was migrated 2026-08-30 (`apps/server/web/.migration/`) |
| Harnesses | **Plugin packages** the control plane loads (spec 2026-09-10): installed into the instance store at Settings → Plugins, admin-only; a node executes the plane-built argv and holds nothing plugin-shaped. The contract is `@subshell-ai/plugin-api` (`packages/plugin-api`); six plugins ship in `packages/plugins/*`: claude-code, opencode & codex (MCP auto-registered per subshell), hermes & pi (one-time manual registration, steps shown in the preset editor), and terminal (a plain shell, no agent CLI) |
| Frontend | React 19 + TanStack Router/Query + Tailwind; Vite dev server (port 5174) proxies `/api` + `/ws` to backend |
| WS protocol | **All client frames JSON** (`{type:"input"\|"resize"}`) — see `packages/subshell-protocol` |
| Uploads | Dropped/pasted files → `<workingDir>/.subshell/uploads/`, working-directory-scoped, git-excluded, paths injected via bracketed paste |
| Workspaces | Per-user tiling layout of subshell panes via `dockview-react`; `layout_json` holds the split tree. Below 1024px it renders as tabs and never writes the layout, so a phone visit cannot flatten a desktop arrangement |
| Nodes | Other machines run harnesses on the control plane's behalf. Control→agent commands are JWS-signed envelopes (authenticity/freshness/target, not confidentiality); events come back unsigned on the node key. `NodeLauncher` is the ONLY local-vs-remote branch, and the browser `/ws` contract is byte-identical for remote panes — [architecture §9](architecture.md#9-nodes-remote-execution-hosts), wire contract in [node-protocol.md](node-protocol.md) |
| Sharing | A subshell is private to its owner by default (404, never 403, so ids can't be probed). The owner grants **view** or **edit** to Everyone or named users; delete + re-share + the notification bell stay owner-only, admins included. Sharing is a browser act — bearer keys are refused on the shares routes |
| Several viewers | A tmux pane has ONE grid, so the pane is sized to the smallest visible viewer that can type (`shared-geometry.ts` in `@internal/subshell-protocol` — the server APPLIES the rule, the browser EXPLAINS it from the same definition). Everyone attached sees everyone else's device name |
| Distribution | Two binaries, cut by `.github/workflows/release.yml` under component-scoped tags: `subshell-server-cli-<triple>` (SPA embedded, serves its own `mcp` subcommand) and `subshell-node-cli-<triple>` (the node agent) — the `cli` marks a bare binary, against the desktop apps' `Desktop`. Versions bump via changesets; the workflow owns the tags |
| Mobile | <1024px = drawer shell + tab workspaces (`useIsWide`, `WORKSPACE_TILING_MIN_WIDTH`); ≥1024px = today's desktop shell; accessory terminal key bar sends raw WS `input` frames (same path as desktop keystrokes); PWA manifest, no service worker — spec [`superpowers/specs/2026-08-30-mobile-support-design.md`](superpowers/specs/2026-08-30-mobile-support-design.md) |

## Workspace layout

`apps/server/`, `apps/client/` and `apps/node/` are grouping directories — the
tree IS the taxonomy, and none of them carries a `package.json`. Three words,
each naming exactly one thing: a **server** is a control plane, a **node** is a
machine that runs agents, a **client** is a person's interface to a control
plane. See `superpowers/specs/2026-09-07-app-vocabulary-design.md`.

```
apps/server/api            Elysia app: api routes, ws, auth, subshell manager, tmux runner,
                           static serving (built SPA), migrations; the binary serves its own
                           `subshell-server mcp` subcommand — the stdio `subshell mcp` entry
                           (no companion compile target, never opens the app DB)
apps/server/web            React SPA the server serves: TanStack Router/Query, xterm,
                           shadcn/ui, dark theme
apps/server/desktop        Tauri v2 GUI over apps/server/api (installs/runs/manages it)
apps/node/agent            `subshell` — the node daemon: enrolls with the control plane, holds the
                           /ws/node socket, executes signed launch/tmux/fs commands as its OS user
apps/client/desktop        Tauri v2 GUI — Subshell Client: one window showing a control plane's
                           own UI (granted one path-only command, "open in browser"), one bundled
                           window that registers this machine as a node and manages apps/node/agent
apps/client/mobile         native companion (React Native + Expo SDK 57) — push, badge, lock-screen
                           actions, Keychain credential; NOT a second web app
e2e                        Playwright suite (own backend on :3199, real tmux) — outside `bun run test`
brand                      wordmark/palette masters + generators (`bun run brand:generate`)
packages/plugin-api        The contract a plugin implements (published as @subshell-ai/plugin-api)
packages/plugins/*         The five built-in plugins (published as @subshell-ai/plugin-<id>)
packages/pane-runtime      Running a pane here: binary detection, plugin loading, argv, TmuxRunner
packages/backend-errors    shared error handler (scaffold)
packages/backend-client    Eden Treaty client (scaffold; types inferred from backend's `App` type)
packages/subshell-protocol WS frame contract shared by backend + frontend
packages/mcp-core          stdio `subshell mcp` server, served by the backend binary's `mcp` subcommand and by the node agent's `subshell mcp`
packages/tsconfig          shared TS config (scaffold)
```

## Key flows

1. **Setup wizard** (first visit): register admin → manage harnesses → done. No
   preset step — launching needs only an agent and a folder, and a fresh instance
   carries no presets at all (nothing is seeded; every preset is deletable).
   The wizard's final screen pre-fills the agent: a detected agent CLI wins
   (first usable, Terminal last) — the same rule the launch form applies
   everywhere (most recent usable agent, else first usable non-terminal, else
   anything usable).
2. **Create subshell**: choose agent, optional preset, host folder (in-app browser),
   optional name (defaults to date/time) → backend validates, spawns tmux + harness with `env -i` curated env
3. **Terminal page** (`/subshells/:id`): fetches a single-use WS token via an authenticated
   REST call (HttpOnly cookie works for HTTP), connects `/ws?subshell=&token=`, streams
   `replay` + `output` frames into xterm, forwards keystrokes; `capture-pane` replay on attach
4. **Terminate**: kills the tmux session tree; DB row status → `terminated`
5. **Reconcile loop** (60s interval): marks rows `terminated` when tmux session is gone;
   also sweeps expired WS tokens
6. **Workspace** (`/workspaces/:id`): subshells tile via `dockview-react` above 1024px, tabs
   below it; every panel renders with `renderer: "always"` so moving, splitting or hiding
   a pane relocates its terminal in place rather than unmounting and remounting it
7. **Cross-subshell comms**: subshell start mints a bearer token + MCP config → the harness
   spawns `subshell mcp` (stdio) with that token in its inherited env → agents create/join
   **channels**, post E2EE messages (sealed to every member's keypair), long-poll reads
   with a per-subshell cursor, and can spawn/manage other subshells. On terminate/delete the
   token is revoked; auto-restart rotates it. See
   [`superpowers/specs/2026-08-28-cross-session-comms-design.md`](superpowers/specs/2026-08-28-cross-session-comms-design.md)
   and the plan in `superpowers/plans/`.

## Security posture (explicit design)

Headlines only — **[security.md](security.md)** is the authoritative threat
model, including the accepted risks and what is deliberately not defended.

- Binds all interfaces by default (`HOST=0.0.0.0`; `127.0.0.1` re-narrows to loopback);
  Docker compose binds `127.0.0.1`
- All `/api/*` except auth + setup-status requires a session (401 JSON otherwise)
- WS attach requires a **short-lived (30s) single-use token** issued by the authenticated
  REST endpoint — replay-resistant (verified: second use gets `4001 unauthorized`)
- Harness processes run under `env -i` with a **curated env** — app secrets (DB path, auth
  secret) never reach the agent; preset env vars merge on top
- Harness argv built from parts (`buildCommand`), never a shell string
- PTY output treated as untrusted — rendered only by xterm, never as HTML
- Path traversal guard on `/api/files/explore`
- `SameSite=Lax` + `httpOnly` cookies; `secure` in prod
- Single-user-now architected for multi-user: `user_id` on all tables, admin flag via `user_meta`
- **Channel E2EE**: message bodies sealed per-recipient (server stores ciphertext only).
  The boundary protects the server/remote peer from message *content* — **not** metadata
  (channel names, membership, timing, sizes, principals stay plaintext) and **not** a local
  OS user, who can read a subshell's keypair off the same disk. Subshell bearer tokens are
  scoped and revoked on death; system keys are long-lived full-access bearer credentials
  held by admins.

## Testing

- Backend uses **`bun test`** (vitest was removed — its node worker cannot
  import `bun:sqlite`)
- Run: `bun run test` (root, all packages) / `cd apps/server/api && bun test`
- Type check: `bun run verify-types` (root) / `cd apps/server/api && bunx tsc --noEmit` (from the
  package dir, not repo root)
- Lint: biome — `bun run lint` fixes (`--write --unsafe`), `bun run lint:check` verifies read-only
- Hooks: lefthook runs `lint:staged` (+ syncpack) on **pre-commit** and `verify-types` +
  `lint:check` on **pre-push** — the test suite is deliberately NOT in the hook (CI owns it,
  `.github/workflows/test.yml`); the root `prepare` script installs them on `bun install`
- E2E: the repo-root `e2e/` Playwright suite is separate from `bun run test` — `bun run test:e2e`
  boots its own backend on :3199 and needs a real tmux (see `e2e/AGENTS.md`)

## Status

Everything below is shipped and on `main`. (Version numbers deliberately not
quoted here — this file outlives every release, and a pinned number rots the
day the next cut lands.)

- **Core** — single-port serving (built SPA + API + WS + `/docs`), tmux-backed
  subshells, presets, workspaces (tiling above 1024px, tabs below), uploads.
- **Cross-subshell comms** — E2EE channels + the 13-tool `subshell mcp` server,
  pinned by a two-process end-to-end test (real backend + two `subshell mcp`
  children; ciphertext-only storage asserted at the byte level).
- **Auth** — chrome-free sign-in with a signed-out guard and return path,
  passkeys (WebAuthn, same session cookie — an extra credential, never a second
  factor), and break-glass `SUBSHELL_EMERGENCY_PASSWORD` with an instance-wide
  warning banner.
- **Sharing** — per-subshell view/edit grants to Everyone or named users;
  delete, re-share and the notification bell stay owner-only.
- **Several viewers, one pane** — shared output pump, a presence/`viewers`
  frame, a Devices list that explains the pane's size, and the smallest-visible-
  viewer sizing rule shared between server and browser.
- **Nodes** — remote execution hosts end to end: enrollment via single-use setup
  keys, signed commands over `/ws/node`, on-demand harness detection (the plane
  ships its rules; the node probes and answers with raw text), offline
  semantics that say "node unreachable" rather than "crashed", the served
  `/install.sh` + digest-verified binary downloads, and a background service
  installer (systemd user unit / launchd agent).
- **Distribution** — `subshell-server` ships as one self-contained binary per
  triple with the SPA embedded and its own `mcp` subcommand, plus a CLI
  (`version｜status｜init｜configure｜service install｜uninstall`); the node agent
  ships as four. Both are cut by `.github/workflows/release.yml` under
  `server-vX.Y.Z` / `node-vX.Y.Z`, darwin artifacts signed + notarized.
- **Admin** — `/settings/status` renders the whole instance in one read
  (versions, host paths, resolved MCP entrypoint, counts, security posture),
  carrying no secret in any form.
- **Mobile** — the responsive web shell (drawer nav, terminal key bar, tab
  workspaces, Add to Home Screen) plus a native companion app (`apps/client/mobile`)
  for the four things a web page cannot do.

Browser-level coverage is the repo-root Playwright suite — 15 spec files across
desktop and two device projects (iPhone 15 Pro incl. landscape, iPad Pro 11
landscape), including a real `subshell` agent enrolled from source in `12-nodes`.
Run it with `bun run test:e2e`; it is deliberately outside `bun run test`.

### Known deferrals

- No per-subshell cost/usage accounting.
- Internet-grade hardening is out of scope by design: no TLS enforcement, no
  2FA, no rate limiting beyond the login backoff. See
  [`.claude/rules/security-context.md`](../.claude/rules/security-context.md)
  for the checklist that would have to be worked through first.
- Sign-in/sign-out are not audit events (session lifecycle and `user.create`
  are).
- The channel post bus is in-process, so a multi-process deployment would need
  a shared wake channel.
