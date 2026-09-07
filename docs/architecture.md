# Subshell — Architecture Reference

How the running system is put together: processes, credentials, data flows, and
invariants. For *why* specific decisions were made, see the design specs in
[`superpowers/specs/`](superpowers/specs/); for quick orientation, see
[`overview.md`](overview.md). This document describes the code as it exists —
when it and the specs disagree, this one is authoritative for behavior.

Two areas have their own references, and are authoritative over this one where
they overlap: **[`security.md`](security.md)** for the threat model, and
**[`node-protocol.md`](node-protocol.md)** for the node wire contract.

- [1. Process model](#1-process-model)
- [2. Credentials & trust boundaries](#2-credentials--trust-boundaries)
- [3. Encrypted channels](#3-encrypted-channels)
- [4. The `subshell mcp` process](#4-the-subshell-mcp-process)
- [5. Subshell lifecycle & token choreography](#5-subshell-lifecycle--token-choreography)
- [6. Component map](#6-component-map)
- [7. Invariants](#7-invariants)
- [8. Extension points](#8-extension-points)
- [9. Nodes (remote execution hosts)](#9-nodes-remote-execution-hosts)

---

## 1. Process model

Everything runs on one machine (or one trusted network). One Elysia process
serves the browser, the agents, and the outside tooling on a single port.

```
┌─ browser (React SPA, cookie session) ──────────────┐
│   /  /subshells/:id (xterm over /ws)  /settings …  │
└──────────────────────┬─────────────────────────────┘
                       │ HTTP + WS, :3080, same origin
┌──────────────────────▼─────────────────────────────────────────────┐
│ backend (Bun + Elysia)                                             │
│  routes.ts: subshells · channels · identities · system-keys ·      │
│             profiles · workspaces · files · users · audit · ws …   │
│  SQLite (bun:sqlite, WAL) — app Kysely handle + separate auth      │
│  handle (better-auth tables, incl. `apikey`)                       │
└──────┬─────────────────────────────────────────────────────────────┘
       │ spawns (tmux new-session, env -i curated)
┌──────▼─────────────────────────────────────────────────────────────┐
│ tmux server, one socket per subshell: subshell-<sha1(subshellId)[:12]> │
│  └─ harness CLI (claude …) — pane env carries SUBSHELL_* credentials   │
│      └─ `subshell mcp` (stdio MCP server, spawned by the harness via   │
│          its per-harness registration; inherits the pane env;      │
│          talks back to the backend over HTTP as this subshell's    │
│          bearer token)                                             │
└────────────────────────────────────────────────────────────────────┘
```

Key properties:

- **The backend is the only long-lived trusted process.** Harnesses and
  `subshell mcp` children are untrusted consumers of the public HTTP API — there
  is no backdoor IPC.
- **tmux is the source of truth for liveness**; the DB row is a record of
  intent, reconciled every 60 s (`SubshellManagerService.reconcileAll`).
- **`subshell mcp` never opens the app database.** It is served by
  `@internal/mcp-core` alone (the server binary's `mcp` subcommand or the agent's) —
  the served code path touches no db/auth state — the entry graph does no IO
  at import (purity-tested), so a compromised agent process holds no SQLite
  handle or auth secret. (The compiled server binary BUNDLES the boot graph
  for its other subcommands; bundling is not opening — the purity tests pin
  that evaluating it opens nothing.)
- **The terminal transport does not fork for mobile.** The accessory key
  bar sends the same JSON `input` WS frames defined in
  `packages/subshell-protocol` that desktop keystrokes already use
  ([spec](superpowers/specs/2026-08-30-mobile-support-design.md)).

## 2. Credentials & trust boundaries

Three actor kinds reach `/api/*` through one guard
(`apps/server/api/src/api/auth-guard.ts`), which injects
`{ user, principal, actor, apiKeyId, apiKeyPermissions }` into every route
context.

| | cookie (human) | system key | subshell token |
|---|---|---|---|
| Header | `better-auth.session_token` cookie | `Authorization: Bearer subshell_…` | same |
| `actor` | `cookie` | `system-key` | `subshell-key` |
| `principal` | `user:<id>` | `user:<systemUserId>` | `sess:<subshellId>` |
| Minted by | sign-up / wizard | admin via **Settings → System API keys** → `POST /api/system-keys` | server-side `issueSubshellToken` at subshell start |
| Scope | the user's own data; **admin surfaces require this actor** | full access, no permission map | `permissions` grant map (`channels`, `subshells` × `read`/`write`) |
| Lifetime | better-auth session | forever until disabled/deleted | 7 days, self-extends via `POST /api/subshells/:id/extend-token` (self-only) |
| Revocation | sign-out / password change | instant (disable/delete) | **instant on terminate/delete**; rotated on auto-restart |

Hard rules enforced by the guard (each is tested):

1. **Bearer keys never manage the instance.** `requireAdmin` rejects any
   non-cookie actor with 403 (`/api/users`, `/api/system-keys`, …).
2. **Subshell-principal forgery is impossible.** The api-key plugin's
   public create endpoint lets any signed-in user attach arbitrary metadata,
   so the guard does *not* trust `metadata.kind === "subshell"` alone — the
   subshell row's `api_key_id` column (written only by the server's
   `issueSubshellToken`) must equal the presenting key's id. As a second
   layer, `/api/auth/api-key/*` self-service endpoints are blocked at the
   mount (`plugins/auth.plugin.ts`).
3. **System actor requires system ownership.** A key whose `referenceId` is
   not the `system` service user is not a `system-key`, whatever its
   metadata claims.
4. **Subshell tokens die with their row.** A valid key whose subshell row
   is gone 401s — the row, not the key, is lifecycle truth.

All raw SQL against better-auth's `apikey` table and the metadata vocabulary
(`kind: "subshell" | "system" | "node"`) live in exactly one module:
`src/auth/apikey-store.ts` (the plugin's own update/list endpoints are
bearer-blocked and unusable server-side; system-key scoping uses
`json_extract`, deliberately not a string `LIKE`, so a serialization change
upstream can never silently make a full-access key un-disable-able).

**E2EE does not mean E2E-trusted.** The channel crypto (§3) protects message
*bodies* from the server's storage, backups, and remote peers. It does not
hide metadata (who is in a channel, posting times, sizes) and does not
protect against a local OS user, who can read keypairs and pane contents off
the same disk. See [`security.md`](security.md) for the full threat model.

## 3. Encrypted channels

Global (not per-user) append-only logs that subshells use to talk to each
other. The server stores and relays **opaque General JWE envelopes it cannot
read**; all crypto happens client-side in `subshell mcp`.

### Data model (migration 0009)

```
channels(id, name, created_by)                      global, name is the slug
identities(principal_id, public_key, display_name)  one ECDH keypair per principal
channel_members(channel_id, principal_id, added_by) idempotent join
channel_posts(id, channel_id, seq, author, envelope, created_at)
   UNIQUE(channel_id, seq)   ← seq assigned MAX+1 inside a tx (SQLite single-writer)
channel_post_recipients(post_id, principal_id)      ← denormalized so the server
   can filter "posts you can decrypt" WITHOUT decrypting them
channel_cursors(channel_id, principal_id, last_seq) per-reader position; advances
   with max(stored, new) — never rewinds, so racing readers can't lose history
subshells.api_key_id                                the token-link column (§2 rule 2)
```

### The envelope

One shared content key per post, per-recipient key wraps (`jose`):

- Algorithm `ECDH-ES+A256KW`, encryption `A256GCM`, keys P-256.
- Each recipient wrap carries an **unprotected** header `kid: <principalId>` —
  the server uses the recipients table for visibility, never the kid; the kid
  only tells the *reader's* own process which wrap to open.
- The server structurally validates envelopes on POST (must parse as JSON,
  have `ciphertext/iv/tag` strings and a non-empty `recipients[]`, ≤ 128 KB)
  and otherwise treats them as opaque bytes. Nothing server-side parses
  `ct`. Ever.

### Read path (long-poll)

`GET /api/channels/:name/posts?since&wait&limit&mark`

1. Recipient-filtered query (`INNER JOIN channel_post_recipients` on the
   caller's principal) — a caller can only ever receive posts addressed to
   them, and receives them with the full envelope to decrypt locally.
2. `wait` (≤ 600 s) parks on the in-process **post bus**
   (`services/channels/post-bus.ts`, an `EventEmitter` fired by
   `notifyPosts(channelId)` after each append). The wake predicate is
   recipient-filtered (`countVisibleAfter`) so someone else's post cannot
   collapse your wait into an empty return.
3. `mark=1` advances the caller's cursor to the highest seq returned.

The durable log is the queue: no message-broker exists. Offline subshells
miss nothing — they resume from their cursor when they next read.

### Nudge (opt-in, best-effort)

`POST /api/channels/:name/posts {nudge: true}` types a fixed, **Enter-less**
line (`[subshell] new post in #name`) into the tmux panes of *running*
recipients, so their agents notice traffic without a poll. It never
auto-submits anything into a shell and never fails the post.

### Peer-key pinning (TOFU) — and what a key recovery costs

The sealing side pins each peer's exact public JWK on first post
(`<dataDir>/peers.json`, mode 0600, `@internal/mcp-core` pin-store) and requires
byte-equality thereafter — a compromised relay cannot swap a roster key
without every sender hard-failing (`PinnedKeyMismatchError`). Absent or
typo'd `SUBSHELL_CHANNEL_PIN` means strict; only `SUBSHELL_CHANNEL_PIN=trust` opts
out. The honest operational consequence: when a member legitimately recovers
its identity (corrupt/quarantined identity file → fresh keypair → re-register
into the channel), every peer's `post_channel` to shared channels then
**hard-blocks** on the stale pin — this is the pin working, not an attack.
Recovery is manual per peer: delete that principal's entry from
`peers.json` (the error message names the file) and the next post re-learns
the key, or the operator accepts unpinned sealing via
`SUBSHELL_CHANNEL_PIN=trust`.

## 4. The `subshell mcp` process

A stdio MCP server (SDK v2) the harness spawns per subshell.

### Registration per harness

How the child gets spawned is the harness plugin's dialect decision
(`packages/harnesses`), not a backend special case:

- **claude-code** — the backend writes a per-subshell `mcpServers` file; the
  plugin's `mcpRegistration` returns its content plus the activating
  `--mcp-config <path>` argv, which `buildCommand` splices after the binary.
- **opencode** — the registration returns an opencode-dialect config layer
  (a `mcp.subshell` local entry) and the env `OPENCODE_CONFIG=<path>`; opencode
  merges that layer over the user's own config (verified deep-merge). The
  backend bakes the wiring env LAST in the pane precedence (curated host env <
  `SUBSHELL_*` < profile env < wiring env), so a profile setting `OPENCODE_CONFIG`
  cannot silently drop the subshell's comms.
- **codex** — the registration returns per-invocation argv instead: `-c
  mcp_servers.subshell.command="…" -c mcp_servers.subshell.args=[…]` (dotted config
  paths, values parsed as TOML), which codex merges over the user's
  `~/.codex/config.toml` for that run only. There is no wiring env — the `-c`
  argv IS the wiring, and `CODEX_HOME` (which holds the user's auth.json) is
  never redirected; the file the backend still writes is a manual-setup
  reference codex never reads.
- **hermes, pi** — no per-subshell config format exists (hermes reads only the
  fixed `~/.hermes/config.yaml`; pi needs the community `pi-mcp-adapter`).
  They register once, manually: the profile editor renders the plugin's
  `mcpSetup()` steps verbatim (resolved launch paths included). The single
  global entry stays per-subshell-correct because the spawned child inherits
  each pane's own `SUBSHELL_*` credentials.

`services/mcp-launch.ts:registerSubshellMcp` drives all of this on both the
create and auto-restart paths; manual harnesses write no file at all.

### Boot sequence (`packages/mcp-core/src/server.ts:runSubshellMcp`)

1. Read + validate env (below) — hard-fail with a clear message if missing.
2. Load-or-create the subshell's identity keypair under
   `SUBSHELL_DATA_DIR/identities/sess-<id>.json` (0600; the file stamps its
   principal and refuses cross-principal reuse — silently regenerating a key
   would orphan the subshell's message history; an out-of-band run with no
   `SUBSHELL_DATA_DIR` lands in `<tmp>/subshell-mcp`, never the cwd).
3. Register/rotate the public key with the backend (`POST /api/identities`,
   best-effort).
4. Arm a 12 h unref'd timer that self-extends the subshell token.
5. Serve 13 tools over stdio. **Stdout is the MCP channel** — diagnostics go
   to stderr only.

### Env contract (producer: `services/mcp-launch.ts:subshellMcpEnv`; consumer: `packages/mcp-core/src/env.ts`)

| Var | Meaning |
|---|---|
| `SUBSHELL_API_KEY` | the subshell's bearer token (secret, pane-env only) |
| `SUBSHELL_BASE_URL` | backend URL (default `http://127.0.0.1:3080`) |
| `SUBSHELL_ID` | subshell this process speaks as |
| `SUBSHELL_NAME` | display name for the identity registration |
| `SUBSHELL_DATA_DIR` | where the keypair persists (subshell data dir) |

Deployment override: `SUBSHELL_MCP_COMMAND` / `SUBSHELL_MCP_ARGS` (JSON array) pin how
the server is launched; default resolution (apps/server/api `services/mcp-resolve.ts`) is
env override → SELF (`subshell-server mcp` when compiled, `<bun> <absolute entry> mcp`
under `bun run`) → the `subshell` node agent on PATH (`subshell mcp`).
`subshell-server status` prints which rung answered.

### Tools

Channels (6): `list_channels · create_channel · join_channel ·
channel_members · post_channel · read_channel`.
Subshells (7): `list_subshells · get_subshell · list_profiles ·
create_subshell · restart_subshell · terminate_subshell ·
delete_subshell`.

There is deliberately no `update_subshell_notes`: the operator-note feature
was removed with its UI (spec 2026-09-03 follow-up), so a tool writing it had
no reader.

Handler-level notes:

- `post_channel` auto-joins the poster, then seals to **every keyed
  member including itself** (so its own history reads back).
- `read_channel` omits `since` unless given, letting the server resume
  from the stored cursor; waits are issued in ≤ 50 s slices against a
  wall-clock budget; undecryptable envelopes are counted, not fatal (e.g.
  after a key rotation). The MCP request's `AbortSignal` is forwarded into
  the in-flight fetch, so a cancelled tool call releases its backend socket.
- Errors surface as short actionable text (`describeToolError`), never stack
  traces.

## 5. Subshell lifecycle & token choreography

`SubshellManagerService` (constructor-injected `subshells`, `profiles`,
`tokens`, `tmux`) orchestrates everything; routes stay thin.

**Create** (`POST /api/subshells`, also driven by the agent via
`create_subshell`):

```
validate profile+dir → insert DB row → issueSubshellToken (writes api_key_id)
→ subshellMcpEnv(apiKey, id, name)  ← single producer, merged into `env -i`
→ registerSubshellMcp (writes the 0600 config file; NO secrets — env carries them)
→ tmux new-session → #deliverPrompt (optional prompt typed once the pane
  shows output, then Enter)
```

The response includes `promptDelivered` — honest about whether the settle
window succeeded (see caveats).

**Death & renewal:**

| Event | Token effect |
|---|---|
| terminate / delete | revoke **before** the row goes away (`enabled = 0`) |
| crash, no auto-restart opted-in | revoked by the 60 s reconcile sweep |
| crash, backoff limit exhausted (5 tries) | revoked too — "never coming back" |
| auto-restart | **rotation**: revoke old, issue new, bake into the re-spawned pane (env is baked at spawn, so an old key can't outlive its process) |
| subshell idles ≥ 7 d | extend timer keeps it alive while the MCP child runs; a dead child's token expires on its own |

The plaintext token exists in exactly two places: briefly in backend memory
at mint, and in the harness pane's environment (visible in `/proc/<pid>/environ`
to the same OS user — accepted; see threat model). It is never stored in the
clear (only better-auth's hash lands in SQLite) and never echoed to any HTTP
response or on-disk MCP config.

## 6. Component map

```
apps/server/api/src/
├── api/
│   ├── auth-guard.ts          authGuard + requireAdmin + requirePerm + HttpError;
│   │                          the ONLY place credentials become principals
│   ├── channels.route.ts      channels REST (slugs ^[a-z0-9][a-z0-9-]{0,63}$)
│   ├── identities.route.ts    public-key registration per principal
│   ├── system-keys.route.ts   admin CRUD for system keys (cookie-admin only)
│   └── subshells/             subshell REST (per-route dir) + extend-token (self-only for subshell actors)
├── auth/
│   ├── apikey-store.ts        ALL raw apikey SQL + kind vocabulary
│   ├── system-user.ts         the `system` service user (owns system keys)
│   └── database.ts            cached better-auth handle (separate from Kysely's)
├── services/
│   ├── subshell-tokens.ts     issue / revoke / extend subshell tokens
│   ├── subshell-manager.service.ts  lifecycle orchestration (§5)
│   ├── mcp-launch.ts          MCP config file + subshellMcpEnv (single producer)
│   ├── mcp-resolve.ts         pure launch ladder (env override → self → client-on-PATH)
│   └── channels/
│       ├── post-bus.ts        in-process append notifier (single-process scale is fine)
│       ├── read-wait.ts       long-park primitive (event-driven + timeout)
│       └── nudge.ts           best-effort tmux send-keys, injectable transport for tests
└── db/migrations/0009-channels.ts   the six tables + sessions.api_key_id
    (0019 renamed the session tables/columns — subshells.api_key_id today)

packages/mcp-core/src/         the `subshell mcp` child implementation (serves both the
                               server binary's and the agent's `mcp` subcommand);
                               imports NOTHING outside
                               node builtins + jose + zod + @modelcontextprotocol/*
├── env.ts                 env contract consumer (mirror of mcp-launch's producer)
├── server.ts              boot + tool registration + AbortSignal plumbing (runSubshellMcp)
├── tools.ts               the 13 handlers (pure over an injectable api client)
├── api-client.ts          tiny fetch wrapper (Bearer + ApiError{status})
├── crypto.ts              seal/open (jose), DecryptError
├── identity-store.ts      keypair persistence + principal-stamp guard
└── pin-store.ts           TOFU peer pins (peers.json)

apps/server/web/src/                (the channel/key surface specifically; the app is much larger)
├── components/system-api-keys-card.tsx   system keys (Settings page)
└── hooks/use-system-keys.ts              TanStack Query hooks over /api/system-keys
```

## 7. Invariants

Anything violating these is a bug; most are pinned by tests (including the
two-process e2e in `src/__tests__/e2e-cross-subshell.test.ts`):

1. The server stores ciphertext only — a plaintext scan of the DB files after
   real traffic must find nothing.
2. A reader only ever receives envelopes addressed to them (recipient join),
   and envelopes they cannot open are counted, not fatal.
3. Cursors move forward only.
4. Every request authenticates; bearer keys cannot reach admin surfaces;
   subshell principals require the `api_key_id` link.
5. Subshell tokens are revoked synchronously with termination/deletion;
   auto-restart rotates (never reuses) the key.
6. `subshell mcp` runs hermetically: no DB handle, no auth secret, secrets only
   via inherited env.
7. Post seq is gapless per channel (UNIQUE + tx-assigned MAX+1).
8. Nudges never press Enter; posts never fail because a nudge failed.
9. Channel waits are bounded (≤ 600 s); envelopes bounded (≤ 128 KB); slugs
   bounded by pattern.

## 8. Extension points

- **Other harnesses**: five plugins ship (§4) across three registration
  dialects — a config file + activating argv (claude-code), a merged config
  layer pointed at by env (opencode), per-invocation `-c` overrides (codex) —
  plus the manual-registration path (hermes, pi). A new harness picks whichever
  its CLI supports; the env producer (`subshellMcpEnv`) is harness-agnostic, so
  anything that reads `SUBSHELL_*` from its pane env gets the same wiring.
- **Federation**: principals are already opaque labels (`sess:<id>`,
  `user:<id>` — future `remote:<instance>/<id>` fits the schema unchanged),
  channels are global with cursor reads, and envelopes are standard JWEs
  addressed by `kid`. The spec notes A2A as the protocol to evaluate if real
  instance-to-instance work starts; nothing federation-shaped is built yet.
- **Known caveats** (live-tested): prompt-on-create can land in the input
  line without submitting when the harness paints early (`promptDelivered`
  reports what happened — verify before trusting it); the post bus is
  in-process only, so a future multi-process deployment needs a shared wake
  channel; the E2EE boundary says nothing about metadata.

## 9. Nodes (remote execution hosts)

A node is another machine that runs harnesses on the control plane's behalf
([spec](superpowers/specs/2026-08-31-nodes-design.md); the wire contract in full
is [`node-protocol.md`](node-protocol.md)). The daemon on it is
`subshell` (`apps/client/agent`, see
[`apps/client/agent/AGENTS.md`](../apps/client/agent/AGENTS.md)); the control-plane side is
`apps/server/api/src/services/nodes/` + `api/nodes/`.

**Registry.** Rows in `nodes` / `node_shares` / `node_setup_keys` /
`node_harnesses` (migration 0017). REST: setup keys mint single-use `nsk_…`
enrollment credentials; `POST /api/nodes/enroll` consumes one and returns the
node's long-lived bearer key exactly once; shares follow the subshell model
(any share grants launch, `edit` adds node config); per-node harness enablement
and Re-check live beside it. A node key can do **nothing on REST** — the auth
guard rejects `kind: "node"` keys outright (spec §5.5); its whole blast radius
is impersonating that node on `/ws/node`.

**The wire.** Commands flow control-plane → agent as JWS-signed envelopes
(`packages/subshell-protocol/src/node-signing.ts`; the signing keypair is
generated once at `<SUBSHELL_SERVER_DATA_DIR>/node-signing.json`, mode 0600,
`services/nodes/control-keys.ts`). Signing proves authenticity/freshness/target
(`iss`/`aud`/`exp`/`jti` + a per-connection `seq` hint) — not confidentiality
(that is WSS/operator TLS). Events flow back **unsigned**: the node key on the
socket is the authentication. The agent verifies every command envelope before
executing anything; the trust boundary this creates is documented in
[`security.md` §6](security.md#6-nodes), and the envelope itself in
[`node-protocol.md` §4](node-protocol.md#4-command-envelope-and-replay-defense).

**The seam.** `NodeLauncher` (`services/nodes/node-launcher.ts`) is the only
local-vs-remote branch point: `LocalLauncher` wraps today's tmux/fs calls,
`RemoteLauncher` implements every method as a signed `sendCommand` over the
node's live socket (`node-rpc.ts` + `node-registry.ts`, newest-socket-wins).
Two load-bearing invariants: per-node dispatch stays **serialized in call
order** (`conn.sendChain` — a slow `launch` can never interleave with a
`write_file`), and the browser `/ws` contract is **byte-identical** for remote
subshells — `ws/remote-subshell-ws.ts` relays replay/resize/input over the node
socket so xterm.js cannot tell a remote pane from a local one.

**Offline semantics** (spec §5.6): absence of a socket ≠ absence of the process.
Launching onto an offline node 409s (`NODE_OFFLINE`); the reconcile sweep
**skips** agent rows whose node is offline; subshell views carry `nodeOffline`
so the UI says "node unreachable", never "crashed". The agent's connect-time
`subshells_report` re-projects panes that survived an agent restart so the
control plane heals its rows.

**Distribution.** Prebuilt `subshell` binaries live in `NODE_ARTIFACTS_DIR`
(`SUBSHELL_NODE_ARTIFACTS_DIR`, default `<SUBSHELL_SERVER_DATA_DIR>/node-artifacts`) and
are published by `bun run release:client` from the repo root
(`apps/client/agent/src/scripts/release.ts` — every triple cross-built with
`--bytecode`, sha256 sidecars, atomic tmp+rename publish, all-or-nothing; the
dance is in root `AGENTS.md`). `GET /api/downloads/node/*` gates on a session cookie OR a
valid unconsumed setup key (`peekValid` — consumption-free) and refuses
anonymous; the root-mounted `GET /install.sh` (`api/install-script.ts`) renders
the per-instance installer for a valid key and a usage script otherwise.
The script downloads, **digest-verifies before chmod+exec**, enrolls, and can
relocate install + state via the `SUBSHELL_DATA_DIR` env knob (default: binary in
the CWD, agent-default data dir). The Add-node dialog bakes the command from
`GET /api/settings/public → appBaseUrl` so the rendered URL matches what the
script embeds — and warns when that URL is loopback (a remote node would dial
the wrong machine).

**Background service.** `subshell service install|uninstall`
(`apps/client/agent/src/service.ts`) writes a systemd **user** unit or a launchd
agent (`dev.subshell.client`), self-referencing the running executable (compiled
binary or `bun <entry>` in dev); on Linux the post-install hint is
`loginctl enable-linger` to survive logout. Harness inventory is pushed by the
agent at connect and every 5 min (`daemon.ts` `INVENTORY_PERIOD_MS`, plus the
on-demand `inventory` command) — the launch gate demands a fresh snapshot
reporting the harness installed, so an un-inventoried node cannot silently
fail launches.
