# Cross-Session Communication: Channels, Session Tokens, and the `mote mcp` Adapter

**Date:** 2026-08-28
**Status:** Approved design (brainstorming complete, pending implementation plan)
**Author:** Theo + Claude (brainstorming session)

## 1. Problem

Sessions (CLI agent harnesses running in tmux) currently have no way to talk to
each other. Each session is an island: coordination happens only via the human
at the keyboard. We want sessions to:

1. Communicate with each other through shared **channels** (a blackboard, not 1:1 DMs).
2. **Create and manage other sessions** via MCP — turning mote into an agent
   orchestrator (a session can spawn a helper, give it a task, and converse).
3. Do both over an **authenticated, encrypted** API surface, backed by
   **better-auth API keys** with an admin management UI.

## 2. Decisions ratified during brainstorming

| # | Decision | Choice |
|---|----------|--------|
| 1 | Communication topology | Global shared channels (N-way blackboard), not DMs or terminal injection |
| 2 | Future federation | Don't build it; keep a *replicable-log* data model so it's additive later |
| 3 | Session control via MCP | Full session CRUD (create/list/get/restart/terminate/delete/notes) |
| 4 | Seeding spawned sessions | Optional `prompt` on create, typed via `tmux send-keys` after startup settles |
| 5 | Auth | Two tiers: admin-managed **system keys** at the edge; **per-session tokens** minted at start, revoked at end |
| 6 | Encryption | **Full E2EE now**: per-session keypairs, sealed per-message delivery, server stores ciphertext only |
| 7 | Delivery model | Durable log + read-on-turn + long-poll `wait` + (optional, default-off) tmux nudge. **No message-queue subsystem** |
| 8 | Database | Stay SQLite, written portably via Kysely; Postgres needs its own spec + forcing function |
| 9 | Libraries | `jose` (General JWE), `@modelcontextprotocol/server` v2, `@better-auth/api-key`, better-auth-ui copy-in |
| 10 | External protocols | A2A v1.0 noted as the future *external* facade; not implemented in v1 |

## 3. Why these choices (condensed rationale)

- **Channels, not queues.** Queue machinery (acks, redelivery, consumer groups)
  assumes always-listening consumers. Our consumers are turn-based agents in
  PTYs. A durable append-only log with per-channel `seq` + stored read cursors
  gives ordering, durability, and "no loss while busy" for free. The in-process
  `EventEmitter` behind long-poll reads (mirroring `live.route.ts` precedent)
  covers promptness. `redis`/`nats`/`rabbitmq`: rejected — second source of
  truth, kills the single-binary local-first story.
- **E2EE threat model, stated honestly.** All sessions share one OS user; a
  determined local attacker reads the DB file, `capture-pane`s any session, or
  ptraces processes regardless of what we encrypt. E2EE is therefore *not*
  defense against local sessions spying on each other. Its real value: mote
  **server-side confidentiality** (backups, logs, a future LAN wire, and — the
  federation payoff — a *remote* mote instance we don't trust can never read
  payloads). This limitation is documented here so nobody later mistakes the
  feature for local isolation.
- **Sealed delivery with per-session keys, not PSKs.** A pre-shared channel key
  needs an out-of-band secret handoff on every join — fatal to the "agent
  spawns agent and they just talk" flow. With per-principal keypairs, a new
  session's identity auto-registers at launch; the spawner only mentions a
  channel *name*. Double-ratchet (forward secrecy) solves a threat we don't
  have, at weeks of cost.
- **SQLite.** Post volume is human/agent typing speed; WAL mode is orders of
  magnitude past it. `LISTEN/NOTIFY` matters only with multiple server
  processes; mote is one. Federation syncs over REST, not a shared DB, so
  Postgres wouldn't help there either.
- **A2A (Agent2Agent, now Agentic AI Foundation / Linux Foundation, v1.0.0
  stable March 2026).** Point-to-point task delegation between *addressable*
  agents; no group channels, no message-level encryption, and tmux sessions
  can't be servers. Wrong shape for our core; right shape for tomorrow's
  external edge (see §12).

## 4. Architecture

```
┌── tmux session (claude / hermes / opencode / pi) ───────────────┐
│  harness ──stdio──▶ `mote mcp` (local stdio MCP server,         │
│                      part of the mote binary)                   │
│                      • P-256 keypair; seal/decrypt (jose)       │
│                      • holds per-session token + private key    │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS + Bearer session token
                           │ (ciphertext bodies only)
┌──────────────────────────▼──────────────────────────────────────┐
│ mote backend (single port 3080)                                 │
│  /api/channels/*   /api/sessions/*   /api/identities/*          │
│  @better-auth/api-key plugin (system + session configs)         │
│  authGuard: cookie path (unchanged) + Bearer key path (new)     │
│  in-process post emitter → long-poll reads                      │
│  SQLite (Kysely, portable SQL only): channels, identities,      │
│  channel_members, channel_posts, channel_cursors                │
└──────────────────────────▲──────────────────────────────────────┘
┌──────────────────────────┴─────────────┐  ┌────────────────────┐
│ Follow-up UI: browser E2EE channel     │  │ v1 UI: admin       │
│ viewer (user identity via WebCrypto)   │  │ API-keys card      │
└────────────────────────────────────────┘  └────────────────────┘
```

Principles:

- **REST is the single source of truth.** Channels, sessions, and keys are all
  typed Elysia routes (visible to the Eden Treaty `@internal/backend-client`).
  MCP (`mote mcp`) and any future A2A facade are thin adapters over REST.
  Federation later = REST↔REST log sync jobs; peers never touch the DB.
- **The E2EE endpoint is the local process.** Mote's own HTTP server never
  sees plaintext. Encryption/signature happen inside `mote mcp`, which the
  harness spawns via stdio MCP config, injected at session start.
- **Harness integration.** The session-manager adds `MOTE_API_KEY`,
  `MOTE_BASE_URL`, `MOTE_SESSION_ID` to `curatedEnv()` and registers the stdio
  MCP server per harness (`claude`: `--mcp-config <generated file>`; the
  harness plugins in `packages/harnesses` each know how to consume a remote
  stdio server definition — one small install step per plugin).

## 5. Data model (SQLite via Kysely)

Four new tables + one cursor table. Each gets a migration in
`apps/backend/src/db/migrations/NNNN-channels.ts` **and** registration in the
`migrate.ts` static map (dynamic imports break `bun build --compile`), plus
Kysely db-types files. No SQLite-specific SQL — portable for a later
Postgres move.

### `channels`

| Column | Type / notes |
|---|---|
| `id` | uuid PK |
| `name` | unique lowercase slug (`refactor`) — the handle agents speak |
| `created_by` | **label, not FK**: `sess:<id>`, `user:<id>`, future `peer:<instance>:<id>` |
| `created_at` | ISO 8601 |

### `identities`

Backs "who can hold an encrypted conversation", separate from sessions so
users/peers reuse the shape later.

| Column | Type / notes |
|---|---|
| `principal_id` | PK, same label format as `created_by` |
| `public_key` | P-256 public key, JWK JSON |
| `display_name` | convenience label (e.g. session name); not authoritative |
| `registered_at` | |

A principal has exactly one active keypair; re-registration rotates (old
messages become unreadable to that principal — accepted, documented).

### `channel_members`

Composite PK `(channel_id, principal_id)`; `added_at`, `added_by` (label).
Membership = "your pubkey is on this channel's list" — exactly the recipient
list sealed delivery needs. Any authenticated principal may join any channel
(v1; no approval flow).

### `channel_posts` — the append-only log

| Column | Type / notes |
|---|---|
| `id` | uuid PK |
| `channel_id` | FK |
| `seq` | per-channel monotonic integer (`MAX+1` at insert; safe — single writer); `UNIQUE(channel_id, seq)` is the cursor |
| `author` | derived from the caller's token — never self-declared |
| `envelope` | **General JWE JSON** (jose, `ECDH-ES+A256KW` + `A256GCM`) — opaque to the server |
| `recipient_ids` | JSON array of principal ids (mirrors the JWE `recipients[]` `kid`s; plaintext metadata by design) |
| `created_at` | |

No UPDATE/DELETE on posts (moderation is a future concern with its own
tombstone design). The server validates envelope structure only (base64
fields, non-empty recipients, ≤128 KiB/post); never parses ciphertext.

### `channel_cursors`

PK `(channel_id, principal_id)`, `last_seq`. Server-tracked read position so
`read_channel(wait)` knows "since where"; badges fall out of the same data.

### API keys — zero new app tables

Owned by the `@better-auth/api-key` plugin (tables arrive via existing
`runAuthMigrations()`), version-aligned with better-auth **1.7.2** (the
unauthenticated key-creation CVE GHSA-99h5-pjcv-gr6v is fixed in ≥1.3.26 —
pin accordingly on any upgrade). **Two named configs via `configId`:**

| Config | Owner | Created by | Expiry | Notes |
|---|---|---|---|---|
| `system` | dedicated `system` service user | admins, UI | none | named keys (`lan`, `ci`, …) for humans/peers |
| `session` | session's owning user | server only | `expiresIn` (7 d), extended not created longer | one per running session; per-key rate limits |

Session keys carry `metadata: { session_id, kind: "session" }`
(`enableMetadata: true`) for revoke-by-session; permissions are
plugin-enforced: `{ channels: ["read","write"], sessions: ["read","write"] }`.

## 6. REST surface (source of truth)

All under `authGuard` (which gains a Bearer branch, §8). Standard project
conventions: `t` schemas with descriptions, `detail: {operationId, tags}`,
existing error types from `@internal/backend-errors`.

| Route | Notes |
|---|---|
| `POST /api/identities` | register/rotate **my own** pubkey (principal derived from token; writing someone else's → 403) |
| `GET /api/identities/:principalId` | fetch a pubkey |
| `POST /api/channels` `{name}` | create; 409 on slug taken |
| `GET /api/channels` | list with member counts |
| `GET /api/channels/:name/members` | members **with pubkeys** (senders need them) |
| `POST /api/channels/:name/members` | join (idempotent) |
| `POST /api/channels/:name/posts` `{envelope, recipientIds, nudge?}` | → `{seq}`; server checks `recipientIds` covers every `kid` it can see in the envelope headers; `nudge` (default false) fires the tmux notification (§9) |
| `GET /api/channels/:name/posts?since&wait&limit&mark` | long-poll; returns **only posts whose `recipient_ids` include me** (server-side filter — clients never see "unreadable" noise); `mark=true` advances my cursor |
| `GET /api/channels/:name/cursor` | my current position (cheap badge poll) |
| `POST /api/sessions` *(existing)* | **gains optional `prompt`** (see §9) + accepts Bearer key auth |
| `GET/PATCH` `/api/sessions…` *(existing)* | full CRUD now reachable by keys with `sessions` permission |

Long-poll: `wait` clamped ≤10 min server-side; heartbeat comments; timeout is
a successful `{posts: []}`. `mote mcp` chunks waits to ~50 s internally so no
MCP *client* timeout can fire.

## 7. MCP surface — `mote mcp` (local stdio server)

New subcommand in the compiled mote binary, using
`@modelcontextprotocol/server` v2 (`McpServer` + `StdioServerTransport`;
handlers get `ctx.mcpReq.signal` — an AbortSignal on client cancel/disconnect,
which we forward to the in-flight fetch).

**Bootstrap (during MCP `initialize`, so it cannot be skipped):** read
`MOTE_API_KEY`/`MOTE_BASE_URL`/`MOTE_SESSION_ID` → load or generate P-256
keypair at `SESSION_DATA_DIR/identities/<session-id>.json` →
`POST /api/identities`.

| Tool | Wraps |
|---|---|
| `mote_list_channels` · `mote_create_channel` · `mote_join_channel` | channels |
| `mote_read_channel(name, since?, wait_seconds?, limit?)` | GET posts + `generalDecrypt`; returns `{seq, author, text, at}` |
| `mote_post_channel(name, text)` | fetch members → one random CEK → `GeneralEncrypt` with one `addRecipient(pubkey)` per member (`kid` = principal id) → POST |
| `mote_channel_members(name)` | members |
| `mote_list_sessions` · `mote_get_session` · `mote_list_profiles` | sessions/profiles |
| `mote_create_session(name, profile, working_dir, prompt?)` | existing POST + prompt |
| `mote_restart_session` · `mote_terminate_session` · `mote_delete_session` · `mote_update_session_notes` | full CRUD |

Plaintext exists only inside the local process and the harness PTY. Crypto
code is `jose` calls (General JWE, `ECDH-ES+A256KW`, `A256GCM`) — pure
WebCrypto, identical in Bun-compiled binary and (future) browser UI. No
hand-rolled primitives anywhere.

## 8. AuthN / AuthZ

### `authGuard` extension

If `Authorization: Bearer <key>` → `auth.api.verifyApiKey` via
`customAPIKeyGetter` (plugin hashes and checks; pass the route's required
`permissions` so the plugin enforces them) → derive principal: session keys →
`sess:<metadata.session_id>`; system keys → `user:<userId>`. No bearer →
existing cookie path, unchanged. **Verify-only** on this path — never
`getSession` with the same key (known double rate-limit-decrement trap).
WS/SSE short-lived-token flow (`ws-token.ts`) untouched.

### Session-token lifecycle

1. `createSession()` → `auth.api.createApiKey` (config `session`, name
   `sess:<id>`, metadata `session_id`, 7 d) → inject into `curatedEnv()`.
2. **Self-extension:** `POST /api/sessions/:id/extend-token` is callable by a
   session token **only for its own id** (resets expiry to a fresh 7 d) —
   long tasks never die mid-flight, but no principal can widen its own
   permissions.
3. Restart rotates the key; `terminateSession` / `deleteSession` / the 60 s
   `reconcileAll` sweep (covers killed/crashed tmux) revoke by session id
   (`updateApiKey {enabled: false}`), and expired keys are auto-cleaned by
   the plugin.

### System keys (admin)

Created/revoked only by admins (existing `requireAdmin` pattern) via thin
`/api/system-keys` routes wrapping server-side `createApiKey`/`updateApiKey`
under the `system` config. UI: copy-in
`npx shadcn add @better-auth-ui/api-key` component, adapted to call those
admin routes instead of the per-user plugin endpoints (copy-in means editing
is supported, not fighting). Frontend gains its first real better-auth
client deps (`better-auth/react` + `@better-auth/api-key/client`) inside the
copied card's `AuthProvider`.

## 9. Session-manager integration

- `createSession()` gains optional `prompt: string`. Delivery: after spawn,
  poll `capture-pane` until first output + a short settle window (cap ~15 s),
  then `send-keys` + Enter. If the pane never settles, the session stays up
  and the response reports `created, prompt not delivered` — caller decides.
- Token mint/revoke hooks land in create/restart/terminate/delete/reconcile.
- `curatedEnv()` gains `MOTE_API_KEY`, `MOTE_BASE_URL`, `MOTE_SESSION_ID`.
- Each harness plugin declares how to register the stdio MCP server (flag or
  generated config file); the session-manager renders a per-session
  MCP config where the harness needs a file rather than a flag.
- **Tmux nudge (opt-in, default off):** with `nudge=true` on a post, mote
  `send-keys` one line — `[mote] 1 new post in #<name>` — to each recipient
  *session* principal's pane (user/peer principals skipped). It is the only
  mechanism that reaches a truly asleep session, and it can interrupt, so it
  is per-post explicit, never implicit. `mote mcp` exposes it as an optional
  `nudge` arg on `mote_post_channel`.
- **v1 non-goal:** arbitrary typing into an *already-running* session's
  terminal (WS `input` stays browser-only; the nudge line above is a fixed,
  server-generated string — not user input). `prompt` at create covers
  orchestration.

## 10. Frontend scope (v1)

- Admin settings card: system API keys (copied better-auth-ui component
  adapted to `/api/system-keys`).
- A **browser E2EE channel viewer** (user registers a browser identity
  keypair via WebCrypto, joins channels, decrypts with `jose`
  `generalDecrypt`) is specced as the immediate follow-up, *not* v1 — the
  schema and crypto need no changes to support it.

## 11. Error handling & edge cases

| Case | Behavior |
|---|---|
| New member reads history | Sees nothing pre-join (server recipient-filter); by design, no error noise |
| Long-poll timeout | 200 `{posts: []}` — success, not error |
| 401 inside `mote mcp` | One transparent `extend-token` retry; then tool error in plain English ("session token revoked or expired — restart the session") |
| Prompt race | §9 settle-window heuristic; explicit "created, prompt not delivered" |
| Envelope malformed / >128 KiB / recipients mismatch | 400 |
| Channel name taken | 409 |
| Join nonexistent channel | 404 — no silent auto-create; `mote_create_channel` is explicit |
| Channel delete | Cascades members/posts/cursors |
| Identity file deleted | New keypair registers under same principal; old posts unreadable to that session. Documented, unguarded |
| Mote restart with live sessions | Tokens live in DB (survive); local processes reconnect; reconcile sweep revokes orphans |
| Key rotation mid-channel | Rotator loses own history access; others unaffected (per-message CEKs) |
| v1 out of scope | Leave-channel, membership approval, history search (server can't read it), message edit/delete |

## 12. Security posture & federation

- **Metadata is plaintext by design:** channel names, membership graph,
  author labels, timestamps, sizes, recipient lists. Payloads are not.
  Documented in `docs/overview.md` security section.
- **Local-OS-user boundary is NOT protected** (§3) — this feature guards the
  *server/remote* boundary.
- **TLS:** localhost needs none; LAN deployments run mote behind a
  TLS-terminating proxy (or Elysia TLS directly) — operator note, no code.
- **Federation (future):** the append-only `seq` + cursor model syncs as
  store-and-forward REST pulls (`GET posts?since=`), with `peer:<instance>:<id>`
  principals and per-peer scoped keys. Nothing in this design forbids it;
  nothing here builds it.
- **A2A interop (future, external edge):** A2A v1.0 (Agentic AI Foundation)
  is the ecosystem standard for agent↔agent traffic across systems. It does
  *not* fit our core (point-to-point tasks between addressable agents; tmux
  sessions aren't servers; no group channels; no message-level encryption).
  When external interop arrives, mote exposes an **A2A facade as one more
  adapter** over the same REST core: signed Agent Card at
  `/.well-known/agent-card.json`, `message/send` → session-create + channel
  post, SSE binding → our long-poll. Our message vocabulary stays close to
  A2A `Message`/`parts` naming to keep this cheap.

## 13. Testing

- **Crypto unit:** General JWE N-recipient round-trip; non-recipient decrypt
  fails; recipient-filter keys only off `recipient_ids`; envelope shape
  validator; keypair persist/rotate.
- **Token lifecycle service:** mint→verify permission matrix (missing perm →
  403); self-extend only own id; terminate/delete/reconcile all revoke;
  expiry auto-cleanup.
- **`authGuard`:** cookie regression unchanged; bearer valid/invalid/expired/
  revoked; principal derivation `sess:`/`user:`. Uses the boot-DB recipe
  (temp `DATABASE_PATH`), per project convention.
- **Route integration (Eden Treaty):** channel CRUD incl. 409/404,
  recipient-filtered reads, cursor + `mark`, long-poll empty-on-timeout
  (fake timers), size-cap 400.
- **Headline e2e:** spawn two `mote mcp` stdio children against a live test
  backend, driven by `@modelcontextprotocol/client`: session A blocks in
  `mote_read_channel(wait)`, session B posts, A receives B's plaintext, while
  the SQLite row shows ciphertext only — **this is the feature's definition
  of done.**
- **Session-manager:** prompt typed only after pane-settle (mocked
  `TmuxRunner`); reconcile revokes zombie-session tokens.
- **Early spike (do first):** `bun build --compile` + `mote mcp` + real
  `claude` client smoke test — validates MCP SDK v2 under compile, our
  static-import rules, and client timeout behavior with ~50 s chunked waits.
- **Per project rules:** `bun run verify-types && bun run lint:check && bun run test`,
  plus `turbo build` (new routes must propagate through
  `@internal/backend-client`'s inferred types).

## 14. Dependencies (pin exact versions; run `syncpack fix` after `bun add`)

| Package | Where | Purpose |
|---|---|---|
| `@better-auth/api-key` 1.7.x | backend | api-key plugin (separate package as of 1.7) |
| `jose` 6.x | backend tooling, `mote mcp`, (future) frontend | General JWE sealed delivery |
| `@modelcontextprotocol/server` 2.x (+ `core`) | backend package/binary | stdio MCP server |
| `@modelcontextprotocol/client` 2.x | tests only | e2e driver |
| `better-auth` (bump to 1.7.2 if needed) | backend + frontend | server + `better-auth/react` client |
| `@better-auth/api-key` client bits, `better-auth/react` | frontend | copied keys card |
| better-auth-ui registry items (copy-in, not an npm dep) | frontend | `<ApiKeys/>` card source |

## 15. Build order sketch (for the implementation plan)

1. Spike: compiled-binary MCP smoke test (§13).
2. better-auth apiKey configs + `authGuard` bearer branch (+ tests).
3. Migrations/tables + repositories (+ tests).
4. Token lifecycle in session-manager + `curatedEnv` + revoke hooks.
5. REST channels/identities routes + post emitter + long-poll.
6. `prompt` on session create + harness plugin MCP-registration steps.
7. `mote mcp` subcommand: bootstrap, crypto, tools.
8. Admin system-keys routes + copied better-auth-ui card.
9. Headline e2e test + docs (`overview.md`, README, security notes).

## 16. Open questions carried to the plan (non-blocking)

- Exact settle-heuristic for prompt delivery (poll interval/keywords vs. pure
  output-idle) — tune during implementation with the mocked-TmuxRunner tests.
- Per-harness MCP config mechanics differ (flag vs file); enumerate per
  plugin in the plan.
- `system` service user creation/migration path.
