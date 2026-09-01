# Nodes — Remote Execution Hosts (Design Spec 2026-08-31)

**Date:** 2026-08-31
**Status:** Approved design
**Scope:** backend (apps/backend), new agent app (apps/agent), web (apps/frontend),
mobile (apps/mobile), shared packages (session-protocol, harnesses)
**Implementation plan:** `docs/superpowers/plans/2026-08-31-nodes.md`

> Naming note: this is unrelated to `2026-08-23-remote-operations-design.md`, which is
> about *operating mote remotely over a VPN*. This spec adds remote *execution hosts*.

## 1. Problem & Goals

mote is single-host by construction: `validateWorkingDir`, `harness.findBinary()`,
`TmuxRunner`, the pipe-pane log tail, and the WS terminal all touch the backend's own
filesystem and process table. A user who needs agentic work done on a specific machine
(e.g. a Mac, for macOS-only tooling) has no way to target it.

A **node** is a machine that can run sessions: the control-plane host itself, or any
Linux/macOS machine running the `mote-agent` daemon. Users launch sessions against a
node; the session's whole lifecycle (launch, live terminal, input, prompt delivery,
restart, terminate, logs) executes there. The node dials **out** to the control plane
over a websocket (NAT-friendly, no listeners on the node), accepts only commands
**signed by the control plane**, and authenticates with a node-scoped API key.

### Decisions (ratified by the product owner, 2026-08-31)

| # | Question | Decision |
|---|----------|----------|
| 1 | Node ownership | **Per-user nodes.** Any user registers their own machines; sharing mirrors the session-sharing model (§4 of the session-sharing spec): private by default (404-not-403), `view`/`edit` grants to Everyone or specific users, admins hold instance-wide `edit` but never delete/re-share |
| 2 | The control-plane host | Seeded as a real `nodes` row with id `local` — one code path for dropdown/config/pinning. Admins manage it as owner; **disabling it as a launch target = an admin deleting its seeded Everyone/edit share row** (no separate flag) |
| 3 | Agent distribution | **The backend serves compiled `bun --compile` binaries**; the Nodes page renders a one-line install command embedding server URL + setup key |
| 4 | Parity | Remote sessions must reach **full feature parity** with local ones; delivered in phases, each phase ships a usable system |

Non-goals (v1): Windows nodes; remote folder browsing (privacy — see §12); agent
auto-update; multi-control-plane/federated setups; queueing commands for offline nodes
(a send to an offline node fails fast).

## 2. Concepts & Ownership

- `nodes` row: `{ id, ownerUserId, name, kind: "local" | "agent", os, arch, hostname,
  status, lastSeenAt, agentVersion, protocolVersion, publicKey, apiKeyId, capabilities,
  inventoryJson, inventoryAt, createdAt, updatedAt }`.
- **`local`** (kind `local`): seeded at boot, owner = the `system` user, **admins
  manage it as if they were the owner** (its shares and harness config are
  admin-cookie operations; rename and delete are disabled outright). No socket ever
  connects for it; `status` is derived (online while the server runs). At boot it gets
  an idempotently-seeded share row `(grantee = NULL "Everyone", permission = "edit")`,
  so every signed-in user can launch there and toggle its harnesses — exactly today's
  Settings-card behavior, expressed under one unified rule. **The admin's "disable
  launching on this machine" switch is the deletion of that Everyone row**; the node
  then vanishes from other users' views like any invisible node (404). There is no
  separate settings flag.
- **agent nodes**: owner = the user who consumed the setup key. Visibility/access is
  resolved exactly like sessions: owner > admin `edit` > grants; invisible otherwise
  (404). New pure resolver `lib/node-access.ts` clones `lib/session-access.ts`
  (`resolveNodeAccess`, `loadNodeAccess`; levels `"owner" | "edit" | "view" | "none"`).
- **Share capabilities (product decision, 2026-08-31 — deliberately NOT the session
  mapping):** **any live node share — `view` or `edit` — grants launch eligibility**
  plus seeing the node (status, harness inventory). `edit` **additionally** grants
  node config: harness enable/disable and the inventory Re-check. Owner-only (never
  conferred by a share — and admins hold it only on `local`): rename, delete, share
  management, key rotation. A session started on a node is the starter's own session;
  it is invisible to the node's owner unless the *session* is also shared.
- **Two-axis rule** (the security keystone): *node* shares gate who may **launch on /
  see the node**; *session* shares continue to gate who may **see/interact with a
  session's panes**. A node grant does **not** expose sessions running on that node to
  the grantee, and does not let the grantee read other users' sessions there.
  Conversely, a session shared to a user works on any node that user can launch on.
  Consequence: the node-detail "sessions on this node" list is always filtered by the
  **viewer's session visibility**, never by node access.
- Node names are unique per owner (`idx_nodes_owner_name`).

## 3. Wire Protocol (`packages/session-protocol`)

New files `src/node-frames.ts` and `src/node-signing.ts`, re-exported from `index.ts`.
Add dep `"jose": "6.2.9"` (matches backend pin). Validators are hand-rolled in the
style of `parseClientFrame` — this package stays schema-lib-free.

### 3.1 Transport

- URL: `GET /ws/node` — a second `.ws()` route in `ws/ws.plugin.ts`, sibling of `/ws`.
- Auth: `Authorization: Bearer <node-key>` header on the upgrade (Bun's `WebSocket`
  client supports a `headers` init option; no protocol gymnastics needed).
- All frames are JSON text. Max frame **1 MiB** both directions (`maxMessageSize` on
  the server route; agent chunks output at ~192 KiB raw).
- Terminal bytes ride **base64** (`data_b64`) on the node link — log bytes are not
  guaranteed valid UTF-8 at chunk boundaries. The backend relay decodes and re-emits
  the existing `{type:"replay"|"output"}` string frames to browsers; the browser
  contract is untouched (§6.5).

### 3.2 Commands (control plane → agent), always inside the signed envelope (§4)

```ts
export const NODE_PROTOCOL_VERSION = 1;

/** Control plane → agent. This is the JWS `cmd` claim payload. */
export type NodeCommandBody =
  | { type: "launch"; sessionId: string; socket: string; cwd: string; harnessId: string;
      profile: ProfileDefinitionWire;              // structural JSON mirror — see note below
      moteEnv: Record<string, string>;             // MOTE_* credentials (control supplies)
      mcp?: { path: string; fileContent: string }; // agent writes 0600 before spawn
      harnessSession?: { id: string; mode: "start" | "resume" };
      sessionName: string; cols?: number; rows?: number }
  | { type: "terminate"; sessionId: string }
  | { type: "kill"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "prompt_deliver"; sessionId: string; text: string;
      settleTimeoutMs: number; pollMs: number }    // agent runs the settle loop → 1 round-trip
  | { type: "capture"; sessionId: string }
  | { type: "probe"; sessionIds: string[] }        // batched has-session + exit-code + pane-title
  | { type: "probe_resume"; harnessId: string; harnessSessionId: string; cwd: string }
  | { type: "stat_dir"; path: string }             // validateWorkingDir on the node's FS
  | { type: "log_read"; sessionId: string; fromByte: number; maxBytes: number }
  | { type: "tail_start"; sessionId: string; subId: string; fromByte: number }
  | { type: "tail_stop"; subId: string }
  | { type: "remove_paths"; paths: string[] }      // delete cleanup: log + mcp config
  | { type: "inventory" }
  | { type: "write_file"; path: string; chunk_b64: string; chunk: number;
      eof: boolean }                     // uploads relay (see §3.4); `chunk` = piece index
  | { type: "ping" };
```

Note `launch` carries **structured** data (cwd, env map, profile definition, MCP file
content), never the assembled shell string — see §6.3 for why. The agent assembles the
pane command itself using the same `buildLaunchCommand()` helper the local path uses
(§6.4).

`ProfileDefinitionWire` is a **structural JSON mirror** of `@internal/harnesses`'
`ProfileDefinition` (JSDoc cross-reference, same field names) — `session-protocol` must
not import `@internal/harnesses` at runtime: the frontend bundles this package, and
harnesses pulls in `node:fs`. The agent validates/decodes the blob against the real
`ProfileDefinition` when executing `launch`.

### 3.3 Events (agent → control), unsigned

The socket is already node-authenticated (§5.2); events are trusted as much as the node
key itself. No per-event signing in v1 (see §12).

```ts
export type NodeEvent =
  | { type: "ready"; agentVersion: string; protocolVersion: number;
      os: "linux" | "darwin" | "unknown"; arch: "x64" | "arm64" | string;
      hostname: string; dataDir: string; capabilities: string[] } // "mcp", "uploads"
  | { type: "inventory"; harnesses: { harnessId: string; installed: boolean;
      version?: string; binaryPath?: string }[]; ts: string }
  | { type: "heartbeat"; ts: string }
  | { type: "result"; ref: string; ok: true; data?: unknown }     // ref = command jti
  | { type: "result"; ref: string; ok: false; error: string }
  | { type: "output"; sessionId: string; subId: string;
      fromByte: number; toByte: number; data_b64: string }
  | { type: "exit"; sessionId: string; exitCode: number | null; at: string }
  | { type: "sessions_report"; sessions: { sessionId: string; alive: boolean;
      exitCode: number | null }[] }                // on connect: panes surviving agent restart
  | { type: "error"; code: string; message: string };
```

### 3.4 Ordering, replay, backpressure

- WS guarantees per-connection order; the agent executes commands **serially** (tmux
  ops are sub-ms; `launch` is the only slow one). No intra-node parallelism, no
  ordering puzzles.
- Output flow: the agent tails its own log per `tail_start` (port of `startLogTail`
  from `ws/session-ws.ts`: fs.watch + size pump). Each `output` event carries byte
  offsets, so the backend relay detects gaps and resumes with `log_read` from its
  cursor. The relay preserves the existing per-browser-socket `lastSize` semantics.
- Backpressure: the agent delays its next tail chunk while `WebSocket.bufferedAmount`
  is high (same shape as the backend pump loop). The relay never drops data; a browser
  socket lagging > 4 MiB is closed — the browser reconnects and replays (existing
  behavior).
- **Uploads**: `MAX_UPLOAD_BYTES` (25 MiB) far exceeds the 1 MiB frame, so
  `write_file` **chunks**: 768 KiB raw pieces, `chunk`-numbered per `(path)`, `eof`
  closes; the agent appends and verifies total size before returning the final
  `result`. A mid-stream failure fails the upload cleanly (temp file discarded).
  Backend-side path composition is already safe for local uploads
  (`uploads.service.ts` `safeUploadName`: basename + sanitize + confine under
  `<workingDir>/uploads`) — the remote path reuses that composition against the
  node-side `workingDir`, and the agent still enforces §7's path allowlist.

## 4. Command Signing

So the agent can prove each command came from *this* control plane, aimed at *this*
node, freshly:

- **Keypair:** control-plane **ECDSA P-256 (ES256)**, generated lazily at first
  enrollment, persisted as a JWK file at `<SESSION_DATA_DIR>/node-signing.json` mode
  0600 — mirroring `apps/backend/src/mcp/identity-store.ts`. Deliberately **outside the
  DB**: databases get dumped/backed-up more casually than the app-data dir that already
  holds 0600 secrets. Losing this file orphans every enrolled node (re-enroll; §12).
- **Envelope:** each command frame is a compact JWS (jose `SignJWT` / `compactVerify`)
  whose payload is:

  ```jsonc
  { "iss": "mote-control", "aud": "node:<nodeId>", "iat": <s>, "exp": <iat + 30>,
    "jti": "<nanoid>", "seq": <connection-monotonic int>, "cmd": { …NodeCommandBody… } }
  ```

- **Agent verification, per frame:** `compactVerify(jws, pinnedKey, { issuer,
  audience: "node:<own id>", maxTokenAge: 30s })`; then
  - `seq` is a **per-connection ordering hint only**: it restarts at 1 on every new
    connection and the agent **resets its tracker on connect** — otherwise a control
    -plane restart would lock the node out forever. Within a connection a regression
    logs and drops the socket; holes across a reconnect are expected. **Replay
    protection is carried by `exp` + the `jti` LRU alone**, never by `seq`.
  - `jti` checked against a ~2048-entry LRU (≥ 2× the exp window) so replays across a
    reconnect double-fire nothing;
  - **effectful** commands (`launch`, `terminate`, `write_file`, `remove_paths`) key
    their action by `jti` → a retried launch is idempotent.
- **Pinning:** the enroll response returns the control public JWK; the agent stores it
  in its config and refuses to rotate it without an interactive re-enroll.
- A uniform 30 s `exp` for all classes: commands are only sent on an open socket; a
  mid-flight drop fails the send (`NodeUnreachableError`) rather than queueing.

**Guarantees:** authenticity to the enrolled keypair, single-target (`aud`), freshness
(`exp`), single-shot (`jti`), plus an in-connection ordering hint (`seq`). **Not guaranteed:** payload
confidentiality (WSS/operator TLS's job — trusted-network posture), protection against
control-plane compromise (the signing key rules all nodes), or agent→control integrity
beyond the node key (§3.3).

## 5. Node Auth & Lifecycle

### 5.1 Setup keys

Dedicated table `node_setup_keys` (§6.1) rather than better-auth apikey rows: these are
**single-use activation codes, not credentials** — no per-request verify path, owner is
a normal user (not `system`), consumption is transactional, and forcing them into the
plugin-owned apikey table would mean raw-SQL lookups-by-hash against someone else's
hash format.

- Format `nsk_<randomBytes(24) base64url>`; shown once (UI mirrors the System-API-keys
  plaintext-once card); stored as SHA-256 hex; default expiry 24 h; owner is the
  creating user; audit on create/consume/revoke; at enroll the presented code is
  SHA-256-hashed and matched by digest equality via the indexed lookup on
  `key_hash` — the plaintext is never compared and never stored (therefore no
  constant-time comparison: single-use short-lived activation codes, not
  long-lived password digests).

### 5.2 Enroll

`POST /api/nodes/enroll` — public (like `/api/setup/*`), body `{ setupKey, name, os,
arch, hostname, agentVersion, publicKey }`:

1. Consume the key **transactionally** (flip `used_at`; re-use → 409).
2. Create the `nodes` row (owner = key's owner, `status='offline'`).
3. Register the agent's public JWK in `identities` under principal **`node:<id>`**
   (the table already anticipates non-`sess`/`user` principals — free future channel
   membership; validated via `assertImportablePublicJwk`).
4. Mint the **node API key**: `auth.api.createApiKey`, `metadata {kind:"node",
   nodeId}`, `permissions {nodes:["read","write"]}`, **no expiry**; write
   `nodes.apiKeyId` (the same anti-forgery link pattern as `sessions.apiKeyId`).
5. Return `{ nodeId, nodeKey, controlPublicKey, wsUrl }`.

The agent generates its own P-256 identity keypair at enroll (stored like
`identity-store.ts`: `<dataDir>/identity.json`, 0600, fail-closed).

### 5.3 Connect / heartbeat / offline

- Every `/ws/node` upgrade: verify key (disabled keys — e.g. the old one after
  rotation — fail verify like invalid ones) → `metadata.kind==="node"` → load node row
  → `nodes.apiKeyId === keyRow.id` (stale-key mismatch). Header reading at upgrade
  uses Elysia's `.ws` `upgrade()` hook (verified available on 1.4.29; it stashes the
  derived node into `ws.data`). **Pre-upgrade failures are HTTP refusals of the
  upgrade — 401 (invalid/disabled key) / 403 (key↔node mismatch)**; there is no socket
  yet, so no close codes apply (nodes have no separate enabled flag — delete is the
  revocation). Post-upgrade, `ready` carries `protocolVersion`; too old → close `4406`
  ("agent update required").
- `ready` event persists `os/arch/hostname/agentVersion/protocolVersion/capabilities`
  and triggers an immediate `inventory`.
- `status='online'` while the socket is open; `lastSeenAt` stamped on every heartbeat
  (agent sends one every 15 s). Socket close or 45 s of silence (checked in the
  existing 60 s sweep in `src/index.ts`) → `status='offline'`.
- Two live sockets for one node (backend-restart race, or `mote-agent run` started
  twice on the box): registry keyed by nodeId, **newest connection wins**, the old
  socket closed `4409` (same module-scope-lease discipline as `restartInFlight`). The
  agent treats `4409` as **terminal** — it exits with "another mote-agent is already
  registered for this node" rather than reconnect-looping (§7).

### 5.4 Rotate / revoke

- `POST /api/nodes/:id/rotate-key` (owner, cookie-only): mint new key, disable old via
  `apikey-store.setApiKeyEnabled`, flip `nodes.apiKeyId` after the new key is durable;
  plaintext-once UI; operator re-supplies the key to the agent (`mote-agent enroll
  --rotate` or edit config).
- Delete node (owner-only; admins cannot, mirroring sessions): 409 while sessions
  still run there unless `?force=true` (terminates first). Disables the api key,
  cascade-deletes shares. `local` cannot be deleted.
- **Referential effects:** `profiles.node_id` is cleared (`SET NULL`) inside the node
  delete transaction — the confirm dialog must warn "N pinned profiles will become
  any-node". `sessions.node_id` carries **no FK** and is never rewritten: historical
  rows keep the id and render "deleted node". (SQLite cannot add a physical FK via
  `ALTER TABLE`, so both rules are service-layer invariants, stated here so the
  implementation doesn't drift.)

### 5.5 What a node key can do

**Nothing on REST.** `deriveFromApiKey` in `auth-guard.ts` grows an explicit named
rejection of `metadata.kind === "node"` (with a spec citation), so the blast radius of
a stolen node key is exactly: open a `/ws/node` socket as that node. The `ApiKeyKind`
vocabulary in `auth/apikey-store.ts` grows to `"session" | "system" | "node"`. If a
node-scoped REST surface is ever needed, a real actor kind is introduced then.

### 5.6 Offline semantics

- Launch onto an offline node → `409 NODE_OFFLINE` (new `BackendErrorCodes`:
  `NODE_OFFLINE`, `NODE_UNREACHABLE`, `SETUP_KEY_INVALID/EXPIRED/CONSUMED`).
- `reconcileRows` **skips** agent rows whose node is offline: absence of socket ≠
  absence of process (unlike local tmux). Session views gain `nodeOffline: boolean`
  so the UI says "node unreachable", never "crashed".
- Restart/auto-restart onto an offline node → same 409 / skipped, retry when it
  returns.

## 6. Data Model & Launch Path

### 6.1 Migration `0017-nodes.ts` (registered in the static `db/migrate.ts` map)

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,                 -- uuid; the seeded local row is literally 'local'
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- 'local' | 'agent'
  os TEXT, arch TEXT, hostname TEXT,
  status TEXT NOT NULL DEFAULT 'offline',      -- projection; truth = live socket
  last_seen_at TEXT, agent_version TEXT, protocol_version INTEGER,
  public_key TEXT,                     -- agent identity JWK (pinned at enroll)
  api_key_id TEXT,                     -- anti-forgery link, mirrors sessions.api_key_id
  capabilities TEXT,                   -- JSON array from `ready`
  inventory_json TEXT, inventory_at TEXT,      -- harness inventory cache (§6.2)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_nodes_owner_name ON nodes (owner_user_id, name);

CREATE TABLE node_shares (             -- exact mirror of session_shares (0016)
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  grantee_user_id TEXT,                -- NULL = Everyone (uniqueness in repo write, as sessions)
  permission TEXT NOT NULL,            -- 'view' | 'edit'
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_node_shares_node ON node_shares (node_id);

CREATE TABLE node_setup_keys (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, label TEXT NOT NULL,
  key_hash TEXT NOT NULL,              -- SHA-256 hex; plaintext never stored
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  used_at TEXT, consumed_node_id TEXT
);

CREATE TABLE node_harnesses (          -- per-agent-node enable/disable (lazy rows)
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  harness_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (node_id, harness_id)
);

ALTER TABLE sessions ADD COLUMN node_id TEXT NOT NULL DEFAULT 'local';
  -- no FK: deleted nodes render "deleted node" for history rows (§5.4)
ALTER TABLE profiles ADD COLUMN node_id TEXT;
  -- NULL = "any node"; no physical FK (SQLite ALTER limit) — the node-delete
  -- transaction SET NULLs pinned profiles (§5.4)
ALTER TABLE recent_paths ADD COLUMN node_id TEXT NOT NULL DEFAULT 'local';
DROP INDEX idx_recent_paths_user_path;      -- was UNIQUE (user_id, path)
CREATE UNIQUE INDEX idx_recent_paths_user_node_path
  ON recent_paths (user_id, node_id, path); -- RecentPathsRepository onConflict
                                            -- columns must match (§9)
CREATE INDEX idx_sessions_node_status ON sessions (node_id, status);
```

Zero backfill needed: every existing row lands on `local`. Row types in
`src/db/types/{nodes,node-shares,node-setup-keys,node-harnesses}.db-types.ts`, all
registered in `db/types/index.ts`; repositories extend `BaseRepository` and register in
`db/repositories/index.ts` + `ApiContext.repos`.

### 6.2 Per-node harness availability

- `harnessPlugins` (global) stays as the **local** node's table; `node_harnesses` is
  rows-only for agent nodes (absent row ⇒ `plugin.enabledByDefault` — the established
  lazy rule). No risky data migration; settings/setup semantics for the local box are
  untouched.
- `api/harness-utils.ts` becomes node-aware:

  ```ts
  export async function harnessUsable(harnessId: string, nodeId?: string): Promise<boolean>;
  export async function usableHarnessIdsFor(nodeId: string): Promise<Set<string>>;
  // local → harnessPlugins.enabled ∧ plugin.isInstalled()      (process probe, today's behavior)
  // agent → node_harnesses enabled ∧ inventory says installed  (cache below)
  ```

- **Inventory staleness:** cached `inventory_json` with a 10-min TTL for usable
  checks; a launch failing with the "harness binary missing" class triggers an
  immediate `inventory` command (refresh-on-demand); the node page has an explicit
  Re-check; `maybeAutoRestart` uses the TTL cache (sweep-cheap).

### 6.3 The `NodeLauncher` seam

The single architectural refactor that makes both worlds one code path. New dir
`apps/backend/src/services/nodes/`:

```
node-registry.ts    # nodeId → live agent connection map (module-scope singleton)
node-rpc.ts         # sendCommand(nodeId, body, timeout) → Promise<result data>; jti↔pending
node-launcher.ts    # NodeLauncher interface + per-row resolution
local-launcher.ts   # today's TmuxRunner + fs code, moved verbatim
remote-launcher.ts  # NodeLauncher over node-rpc + node-signing
node-signing.ts     # control keypair load-or-generate (0600 file); signCommandEnvelope()
node-ws-handler.ts  # /ws/node open/message/close logic (sibling of session-ws.ts)
nodes.service.ts    # (services/) registry CRUD, enroll, share glue
```

```ts
export interface NodeLauncher {
  validateWorkingDir(raw: string): Promise<string>;        // realpath / stat_dir
  resolveBinary(harness: HarnessPlugin): Promise<string | null>; // findBinary / inventory path
  launch(plan: LaunchPlan): Promise<void>;               // ERRATUM: void — see note below
  terminate(socket: string, id: string): Promise<void>;
  killSession(socket: string, id: string): Promise<void>;
  hasSession(socket: string, id: string): Promise<boolean>;
  paneExitCode(socket: string, id: string): Promise<number | null>;
  paneTitle(socket: string, id: string): Promise<{ title: string; command: string } | null>;
  capture(socket: string, id: string): Promise<string>;
  resize(socket: string, id: string, cols: number, rows: number): Promise<void>;
  sendInput(socket: string, id: string, input: string): Promise<void>;
  pressEnter(socket: string, id: string): Promise<void>;
  deliverPrompt(socket: string, id: string, text: string,
                settleTimeoutMs: number, pollMs: number): Promise<boolean>; // ERRATUM: see note below
  logPath(id: string): string;                             // backend path / agent path
  readLogTail(id: string): Promise<{ lines: string[]; truncated: boolean }>;
  readLog(id: string, fromByte: number, maxBytes: number): Promise<{ bytes: Uint8Array; next: number }>;
  tailStart(id: string, subId: string, fromByte: number,
            onChunk: (bytes: Uint8Array, next: number) => void): Promise<() => void>;
  canResume(harness: HarnessPlugin, storedId: string, cwd: string): Promise<boolean>;
  writeArtifact(id: string, kind: "mcp-config", content: string): Promise<string>;
  removeArtifacts(paths: string[]): Promise<void>;
}
```

> **ERRATUM (phase-0 final review wave, 2026-08-31):** `launch()` returns
> `Promise<void>` — `promptDelivered` is not part of the launch result. Prompt
> delivery is its own seam member, `deliverPrompt(socket, id, text,
> settleTimeoutMs, pollMs) → Promise<boolean>` (the mirror of §3.2's
> `prompt_deliver` command), so a remote agent runs the whole settle loop as
> ONE round-trip instead of streaming capture polls through the control plane.
> `pressEnter` is likewise an explicit member (the pre-seam service composed
> sendInput+pressEnter itself).

Every `this.#tmux.*` / local-fs call site in `session-manager.service.ts`
(`createSession`, `#deliverPrompt`, `#reviveRow`, `restartSession`, `terminateSession`,
`deleteSession`, `isAlive`, `reconcileRows`, `#preview`, `#planHarnessSession`) and in
`ws/session-ws.ts` routes through the launcher for `row.nodeId`. `LocalLauncher` is
today's code verbatim behind async signatures — **the existing session-manager test
suite passing against it unchanged is the regression net for the extraction.**

Consequences that shaped the protocol:

- **`canResume` is FS-local** (probes `~/.claude/projects/...`): executes on the node
  via `probe_resume`. The agent runs the *same* `@internal/harnesses` plugin code, so
  resume semantics stay identical on both sides.
- **`validateWorkingDir` is FS-local**: `stat_dir` on the node; the browser folder
  browser (backend-FS `files.route.ts`) has **no remote equivalent in v1** — remote
  working dirs are typed, not browsed.
- **Launch payload is structured, never the assembled shell string**: `curatedEnv()`
  snapshots the *backend's* PATH/HOME and `resolveMcpLaunch()` resolves a *backend-host*
  `mote-mcp` binary — sending the assembled string would bake the wrong env and the
  wrong MCP path into every remote pane.
- **Remote logs live agent-side** (`<agentDataDir>/sessions/<id>.log`, pipe-pane
  target); replay-on-demand via `log_read`. The agent file is the single durable
  artifact: survives backend restart, survives reconnect. `get-session-log` /
  `readSessionLogTail` gain a launcher branch. No backend ring buffer.
- **Preview fan-out:** `#preview` currently does one `capture-pane` per running row per
  list request — over the network that's N round-trips on a hot path. Remote rows read
  a **capture cache** (refreshed by the reconcile sweep's batched `probe` +
  opportunistic `capture`), ≤ 60 s stale. No network on the list path.
- **Reconcile:** agent rows get one batched `probe` per online node per sweep
  (has-session + exit-code + pane-title in a single round-trip), results applied as
  today; agent-pushed `exit` events and connect-time `sessions_report` stamp the same
  updates (both idempotent), giving faster exit observation than local has.

### 6.4 Shared launch assembly (`packages/harnesses` moves)

To keep local and remote launches byte-identical in behavior:

- Move `tmux-runner.ts` + `tmuxSocketFor` from `apps/backend/src/services/tmux/` into
  `packages/harnesses` (zero backend deps — `node:crypto`/`node:path` only; tests move
  with it). Backend and agent both import it.
- Extract `buildLaunchCommand({ env, argv })` — the `env -i` + `ENV_KEY_RE` validation +
  `shellQuote` assembly — out of `buildHarnessCommand` into `packages/harnesses`
  (existing tests pin its byte-identical output). The backend's `buildHarnessCommand`
  becomes a thin wrapper (local behavior unchanged); the **agent** calls the same
  function with **its own** `curatedEnv` (its PATH/HOME/`CLAUDE_PATH` — which is
  exactly what the pane needs) ⊕ `moteEnv` ⊕ profile env ⊕ MCP env.
- MCP on remote nodes: control computes the registration dialect
  (`harness.mcpRegistration`) with `configPath = <agentDataDir>/mcp/<id>.json` (from
  `ready`); ships `{path, fileContent}` in `launch`; agent writes it 0600 pre-spawn;
  `remove_paths` on delete. The pane's `MOTE_MCP_COMMAND` on a node is the
  **mote-agent binary itself** (`process.execPath`) with subcommand `mcp` — the MCP
  server is ported into the agent package (phase 2; its deps are only fetch/jose/fs —
  tool handlers become plain REST calls, same as `mcp/api-client.ts` today). Agents
  without the `mcp` capability get `MOTE_*` env only; the profile editor's manual
  registration steps remain the fallback.

### 6.5 Live terminal relay (`ws/session-ws.ts`)

`handleSessionWs` branches on `row.nodeId`:

- `local` → today's code path, untouched.
- agent → refuse `4004` if the node is offline or `hasSession` says no. Then:
  `capture` → `{type:"replay"}` (through `stripSyncMarkers`); `tail_start(fromByte 0)`
  → `{type:"output"}` frames (same full-history-from-zero semantics as the local file
  tail); browser `input`/`resize` → signed commands (fire-and-forget; local stays
  sync-fast inside the async launcher); browser close → disposer sends `tail_stop`.
  `persistOutput`/`lastOutputAt` unchanged.

The browser-facing contract — frames, sync-marker stripping, reconnect/replay — is
byte-identical. The frontend and mobile need **zero** changes for remote terminals.

### 6.6 Session creation resolution

`POST /api/sessions` body gains optional `nodeId`. Resolution in
`SessionsService.createSession`: explicit body `nodeId` (launch-eligible access —
**any share level**, §2; 404 if invisible) → `profile.nodeId` when pinned → `local`
when launch-eligible there (i.e. its Everyone/edit share row still exists, §2) → the
user's single online launch-eligible node → else `400 "pick a node"`. All validations are
node-aware: profile harness usable **on that node**, node online (409), working dir and
binary via the launcher. The row persists `nodeId`. Session views expose `nodeId` +
`nodeOffline`.

## 7. mote-agent (`apps/agent`)

A new app in the workspace (deployable binary, like backend/frontend/mobile;
`packages/*` is library-only here). Package `@internal/agent`, binary **`mote-agent`**.

- **Deps:** `@internal/harnesses`, `@internal/session-protocol`, `jose` (6.2.9,
  synced), loglayer + terminal transport (root-pinned versions). **No CLI framework**
  (hand-rolled ~40-line arg parser in `src/cli.ts` — precedent: `mcp/main.ts` is a raw
  compiled entry; the CLI has 5 commands) and **no ws dep** (Bun native `WebSocket`
  with `headers`). All static imports — `bun build --compile` requirement.
- **Commands:**
  - `enroll --server <url> --key <nsk_…> [--name n] [--data-dir d]` — generates the
    identity keypair, POSTs enroll, writes config; **preflight: refuses to enroll
    without a working `tmux`** (macOS ships none → hint `brew install tmux`).
    `--rotate` variant re-supplies a rotated node key.
  - `run` — the daemon (foreground; `service install` in phase 3 backgrounds it).
  - `status [--json]`, `version`, `mcp` (phase-2 MCP server),
    `service install|uninstall` (phase 3: systemd user unit on Linux,
    `~/Library/LaunchAgents/dev.mote.agent.plist` with `KeepAlive` on macOS; the unit
    embeds `process.execPath` so compiled binaries self-reference).
- **Config:** `~/.config/mote-agent/config.json` mode 0600:
  `{ serverUrl, nodeId, nodeKey, controlPublicKey, dataDir, name }`;
  `MOTE_AGENT_HOME` env overrides the root (test/e2e isolation, mirroring
  `MOTE_TEST_MODE` spirit). Data dir holds `identity.json`, `sessions/<id>.log`,
  `mcp/<id>.json` (no log rotation — local parity; cleanup via `remove_paths`).
- **Daemon:** connect wss (bearer header) → `ready` (capabilities: `mcp` when the
  compiled binary ships the subcommand, `uploads`) → heartbeat 15 s → verify-JWS →
  serial command executor (`src/commands/{launch,probe,tail,…}.ts`); every
  not-yet-implemented command answers `result{ok:false,error:"unsupported"}` (this
  skeleton lets backend/agent tracks integrate incrementally). Reconnect: full-jitter
  exponential backoff 1 s → 60 s — **but close `4409` "duplicate connection" is
  terminal: exit with a clear "another mote-agent is already registered" message**
  (§5.3). Verification splits: `aud`/`exp`/`jti` enforce, `seq` hints (§4).
- **Agent-side path policy (defense-in-depth, §3.4):** `write_file` and `remove_paths`
  are accepted only when the target's `realpath` falls under `<dataDir>` or under the
  recorded launch `cwd` of a currently tracked session; `..` and symlink escapes are
  refused with `result{ok:false}`. (`stat_dir` stays unrestricted — probing a
  user-typed working dir *is* the feature.) Frame size: Bun's `maxPayloadLength` is
  global (default 16 MiB), so the 1 MiB node cap is enforced as a byte check in the
  message handlers on both ends. Pane-exit watcher per launched session (2 s
  `has-session`/`pane_dead_status` loop → `exit` events). `sessions_report` on connect.
  Inventory every 5 min + on demand via `scanHarnesses()` — a new helper in
  `packages/harnesses` returning the inventory shape from `ALL_HARNESSES`
  (`isInstalled`/`findBinary`/`getVersion`), used by the agent, and available to any
  future local re-probe path.

## 8. Distribution — Backend-Served Binaries

- Env `MOTE_NODE_ARTIFACTS_DIR` (`constants.ts`; default `<SESSION_DATA_DIR>/node-artifacts`).
- Compile script in `apps/agent`: host-target build with `--bytecode --minify` (parity
  with the backend's `compile`), plus four cross builds
  (`bun-{linux,darwin}-{x64,arm64}`) **without** `--bytecode` (bytecode+cross is the
  flakiest combo; revisit only if measured worth it). Artifacts named
  `mote-agent-<os>-<arch>`.
- `src/api/downloads.route.ts` (in `coreRoutes`):
  - `GET /api/downloads/node/:target` (+ `/:target.sha256`) — `target` is a closed
    enum of the four triples; **gated by cookie OR an unconsumed `?setup_key=`** —
    never fully public. sha256 computed on demand (`crypto.subtle`), cached by mtime.
  - `GET /install.sh?setup_key=…` — mounted on the **root app in `server.ts`, before
    the SPA static catch-all** (an `/api`-less path otherwise 404s into index.html);
    `text/plain` rendering of: `uname` platform detection → binary + sha256 fetch →
    checksum verify → `chmod +x` → `./mote-agent enroll --server … --key …` → print the
    next-step (`run` / `service install`). The Nodes page renders this one-liner via
    `CopyCommandRow`.
- **Version compat:** agent sends `protocolVersion` + `agentVersion` in `ready`;
  backend enforces `NODE_PROTOCOL_VERSION`/`MIN_NODE_PROTOCOL_VERSION` → close `4406`
  with "agent update required"; the node detail page surfaces "agent too old" from the
  persisted `protocol_version`. Enroll always succeeds even for an old agent (so it
  can at least show its face for diagnosis). Update path in v1: re-run the install
  command.

## 9. REST Surface

New per-resource dir `apps/backend/src/api/nodes/index.ts` (prefix `/api/nodes`),
one-Elysia-per-endpoint, mounted into `computeRoutes` in `api/routes.ts`. If
`verify-types` trips the TS2589 depth ceiling (commit `4d54554` discipline), rebalance
groups (e.g. move `filesRoutes` → `coreRoutes`) — grouping is behavior-neutral.

| Route | Auth | Notes |
|---|---|---|
| `GET /api/nodes` | cookie or bearer (own-user scoping; sharing+admin boost OFF for session keys, per the session rule) | visible nodes with `access` field |
| `GET /api/nodes/:id` | access ≥ view | 404 when invisible |
| `PATCH /api/nodes/:id` | access owner (rename) | local: admins only, name immutable |
| `DELETE /api/nodes/:id` | owner only; `?force` kills running sessions | local undeletable; admins cannot delete others' nodes |
| `GET/PUT /api/nodes/:id/shares` | owner only, cookie-only | mirrors session-shares contract `{shares:[{granteeUserId,permission}]}`; **`local` special case: admins manage it** (its seeded Everyone/edit row is the machine's launch switch) |
| `GET/POST/DELETE /api/nodes/setup-keys` | cookie (own user) | plaintext-once on create |
| `POST /api/nodes/enroll` | public (setup key is the credential) | §5.2 |
| `POST /api/nodes/:id/rotate-key` | owner, cookie-only | plaintext-once |
| `POST /api/nodes/:id/recheck` | access ≥ edit | sends `inventory`; 409 offline |
| `PATCH /api/nodes/:id/harnesses/:harnessId` | access **≥ edit** (owner, admins on `local`, or an `edit` grantee — §2; `local`'s seeded Everyone/edit row keeps every user able to toggle it, matching today) | 409 not-installed, mirroring `PATCH /api/setup/harnesses/:id` |
| _(no settings route)_ | — | the old `nodes.local_launch_disabled` flag is **replaced** by `local`'s Everyone/edit share row (§2); `ensureLocalNode()` seeds it idempotently, admins delete it to disable |
| `POST /api/sessions` | (modified) | optional `nodeId`; §6.6 |

Schemas: every `t` property carries a `description`; `operationId`s
(`listNodes`, `enrollNode`, …); `ApiErrorResponse` everywhere; new error codes in
`@internal/backend-errors`. Audit events: `node.enroll`, `node.delete`,
`node.key_rotate`, `node.local_share_changed`, `setup_key.create`,
`setup_key.consume`, `setup_key.revoke`. `recentPaths` endpoints gain a `node` scope
param; `RecentPathsRepository.touch`'s `onConflict` columns become
`["userId","nodeId","path"]` to match the recreated unique index (§6.1).

Enabling a harness on an agent node seeds Default profiles the same way
`ensureDefaultProfilesForUser` does today — gated by the node's inventory.

## 10. Frontend

| Area | Files | Work |
|---|---|---|
| Nav | `components/app-sidebar.tsx` | `NAV_ITEMS += { to:"/nodes", label:"Nodes", icon: Cpu }` (per-user page) |
| List | `routes/nodes.tsx` (new) | rows: name, OS/arch chips, `StatusPill` (online/offline/agent-too-old), harness chips, owner + share indicator, `ActionsMenu`; "Add node" → setup-key dialog (copy `system-api-keys-card.tsx`: plaintext-once + `CopyCommandRow` install command) → "waiting for enrollment" poll (refetch `NODES_QUERY_KEY` until the row appears) |
| Detail | `routes/nodes_.$id.tsx` (new) | rename, rotate key (plaintext-once), Re-check harnesses, per-node harness switches (reuse `harness-row.tsx`; hooks gain a `nodeId` param, default `"local"` so the settings card is untouched), Shares dialog, delete, sessions-here list **filtered by the viewer's session visibility** (a node grant never lists others' private sessions — §2) |
| Sharing | `components/sharing-dialog.tsx` (modify) | **generalize to a resource-parametrized dialog** (same `{shares}` PUT contract as sessions) — do not fork a second copy |
| New session | `components/session-picker/new-session-form.tsx`, `routes/new.tsx`, workspace `add-session-dialog.tsx` | `NewSessionFormValue += nodeId`; Node `Select` (remember Base UI needs `items={[{value,label}]}`) listing launchable nodes; profile options filtered to `profile.nodeId == null \|\| === selected`; mismatch server-400 surfaces inline (no toasts — house style). When node ≠ local, `WorkingDirField` degrades to a plain input (no remote browse) |
| Profiles | `components/profile-fields.tsx`, `lib/profile-form.ts` | Node Select: "Any node (default)" / Local / usable nodes; `ProfileRow` + payloads gain `nodeId` |
| Session UI | `session-card.tsx`, `sessions_.$id.tsx`, types | node pill; `nodeOffline` → "node unreachable" copy, never "crashed" |
| Settings | `routes/settings.tsx`, `routes/setup.tsx` | Harness card subtitle "(control-plane host)"; the admin "Allow launching sessions on this machine" toggle writes `local`'s Everyone/edit share row via the shares API (§2) — surface it on the local node's page and link it from Settings; setup wizard copy adds "…or register a Node →" when local has no harnesses |
| Recents | `hooks/use-recent-paths.ts` | `useRecentPaths(nodeId = "local")` → `?node=` param |
| Hooks/types | `hooks/use-nodes.ts`, `use-node-shares.ts` (new), `types/node.ts` | `NODES_QUERY_KEY = ["nodes"]`; `Node` interface mirrors the node view |
| Mobile | `apps/mobile` | mirror `nodeId` on session types + pass-through on create; **node picker may lag one phase** — server default `'local'` keeps mobile correct meanwhile |

## 11. Security Posture Delta

Fold into `.claude/rules/security-context.md` a **"Nodes (remote execution hosts,
spec 2026-08-31)"** section:

- Registering a node delegates **arbitrary command execution under the agent's OS
  user** to the control plane, and delegates pane I/O for sessions launched there to
  everyone those *sessions* are shared with. Node shares and session shares are two
  independent axes (§2): **any node share (view or edit) makes the grantee able to
  launch their own sessions there** — those sessions remain invisible to the node's
  owner unless separately shared.
- A node API key can do nothing on REST (explicit guard rejection, §5.5); its blast
  radius is exactly "impersonate this node on `/ws/node`".
- Command signing (§4) proves authenticity/freshness/target — **not** confidentiality
  (WSS/operator TLS), **not** resilience to control-plane compromise (the signing
  keypair rules every enrolled node), **not** anything about a node operator: whoever
  owns the node's OS user owns every pane the backend launches there, including its
  files.
- **Explicit new exposure:** session bearer keys ride in the launch command and are
  `ps`-visible on the node host (same known exposure the doc already records for the
  backend host). Node local users — and, in effect, anyone with `edit` on a *session*
  running there — hold that session's bearer key. Sharing a *node* does not hand out
  session keys, but anything launched there trusts the machine.
- Setup keys: single-use, 24 h, shown once, hash-at-rest, revocable, audited. The
  install command embeds one in a URL (server logs, shell history) — same posture as
  enrollment links everywhere; revoke = delete the key.
- Disabling the control-plane machine as a launch target = an admin deleting `local`'s
  seeded Everyone/edit share row (§2); the row then vanishes from non-admin views like
  any invisible node — no separate flag exists to drift out of sync with it.
- Trusted-network posture unchanged: node→control traffic is expected to ride the same
  VPN/Tailscale; `wss://` termination is the operator's deployment. **Enroll time
  loopback trap:** if `APP_BASE_URL`/server URL is `localhost`-ish, a remote node will
  dutifully dial the wrong machine — the enroll flow and Nodes page surface the
  resolved URL and warn on loopback.

## 12. Risks & Open Questions

1. **tmux on macOS** — not preinstalled; agent preflight refuses enroll with a brew
   hint; the Nodes page carries a preflight checklist.
2. **Signing-key loss** orphans all nodes (re-enroll each). Open: an admin "rotate
   signing key" flow with a re-enroll grace window.
3. **Long outages**: sessions on a vanished node stay `running` forever (skip-on-offline
   — §5.6). Open: mark `crashed` after offline > N days?
4. **Old-but-connected agent**: v1 warns only. Open: should launches be refused below
   the semver floor?
5. **Remote folder browsing** deliberately cut (privacy: it would expose the node's
   whole FS to anyone who can launch there). `browse_dir` is trivial protocol-wise if
   product reverses this.
6. **Unsigned agent events** — a compromised-node key can poison inventory/status for
   *its own node only*. Acceptable v1; per-event signing is a cheap later addition.
7. **Clock skew** on agents breaks JWS `exp` with confusing errors → the agent logs a
   dedicated skew-hint line on verify failure (estimate from server `ts`).
8. **Preview cache staleness** (≤ 60 s, §6.3) — if dogfooding hates it, agent-pushed
   periodic capture is the fix.
9. **`--bytecode` cross-compile flakiness** — cross builds ship without bytecode;
   negligible perf cost, recorded so nobody "fixes" it back.
10. **Log rotation** — remote logs never rotate (local parity); cleanup only on delete.
    Open if long-lived node disks complain.
11. **Two-agent version rollout ordering** — protocol int is the blunt instrument; a
    `capabilities` string set gives finer gating for later features.
