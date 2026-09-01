# Nodes Phase 1 — Registry, Agent Skeleton, Config UI: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-31-nodes-design.md` (cite "spec 2026-08-31 §N"). Phase outline: `docs/superpowers/plans/2026-08-31-nodes.md` (Phase 1 tracks 1A/1B/1C — this plan executes them task-sequentially; the tracks' seams are the interfaces blocks below).

**Goal:** A user creates a **setup key**, runs `mote-agent enroll` + `run` on a Linux/macOS box, and the box appears **online** on a new **Nodes page** with its OS/arch and harness inventory; harness enable/disable becomes per-node; the session/profile UIs gain node selection/pinning while **sessions still launch on `local` only** (phase 2 flips that). Nothing yet runs remotely — but after this phase, a real machine is enrolled, authenticated, and heartbeating over the frozen signed-command protocol.

**Architecture:** Three layers land together. (1) **Trust**: a control-plane ES256 keypair persisted 0600 outside the DB signs every command; single-use setup keys redeem into a `nodes` row + a `kind:"node"` api key that authenticates ONLY the `/ws/node` upgrade (explicitly rejected on all REST). (2) **Connection**: a module-scope node registry maps `nodeId → live socket`; a tiny RPC (`sendCommand`) correlates commands to `result` events by `jti`; phase-1 agents answer `inventory` and truthfully `unsupported` for everything else. (3) **mote-agent**: new `apps/agent` workspace — hand-rolled CLI (no framework), 0600 config file, Bun-native WebSocket dial-out with full-jitter backoff, importing `@internal/harnesses` so inventory = the same plugin code the backend runs.

**Tech Stack:** Elysia (+ `.ws` with the `upgrade()` hook), better-auth api-key, jose via `@internal/session-protocol`, Kysely, LogLayer, React 19 + TanStack Query + Base UI, `bun test`, Playwright e2e.

## Global Constraints

- Verification after **every** task: `bun run verify-types && bun run lint:check && bun run test` (root), all green before committing. Backend route/schema changes → `turbo build` so `@internal/backend-client` re-infers (`build.md`).
- **Gate rule from phase 0:** never gate on isolated runs of `session-manager.service.test.ts` / `session-manager-mcp.test.ts` (pre-existing order-flake); gate on full suites.
- Migration edits: **0017 has now been booted on this dev box** — DO NOT edit 0017 anymore; any schema change is a new `0018-*.ts` (registered in `db/migrate.ts`).
- Invisible resources → **404**, never 403; insufficient access → 403. Node share capabilities (spec §2): **any share level grants launch**; `edit`/owner adds config. `local`'s visibility/launch eligibility flows ONLY through its seeded Everyone/edit share.
- `deriveFromApiKey` must carry the **explicit rejection** of `metadata.kind === "node"` (spec §5.5) with a test proving a node key 401s on `/api/sessions`.
- Node-key facts: minted with `permissions: { nodes: ["read","write"] }`, no expiry, `nodes.apiKeyId` link re-checked at every upgrade (anti-forgery, spec §5.3). Pre-upgrade failures = HTTP 401/403; post-upgrade failures = close 4406 (protocol) / 4409 (duplicate).
- The node socket speaks ONLY `@internal/session-protocol` frames. Commands are signed via `signCommand` from the protocol package; the agent verifies via `verifyCommand` with **`jtiLru` per-node (survives reconnects!) and `SeqTracker` per-connection (reset on connect)** — see `VerifyContext` JSDoc.
- `apps/agent`: no CLI framework, no `ws` dep (Bun native `WebSocket` with `{ headers }`), pinned deps only (`jose 6.2.9` comes via session-protocol), **static imports only** (`bun build --compile`), `verify-types`/`test` wired into turbo. Agent tests NEVER touch `~/.config`: preload sets `MOTE_AGENT_HOME` to a temp dir.
- Elysia `t`: every property a `description`; every endpoint `operationId` + tags; errors `"ApiErrorResponse"`. JSDoc on public API + interface props. No dynamic imports anywhere.
- Frontend: plain `apiFetch` + hand-typed interfaces (house style, not Eden); Base UI Select needs `items={[{value,label}]}`; no toasts — inline error/success text; query keys colocated (`NODES_QUERY_KEY`).
- Route depth: `api/nodes/` mounts into `computeRoutes` in `api/routes.ts`; if `verify-types` trips TS2589, rebalance groups (move `filesRoutes` → `coreRoutes`) — behavior-neutral.

---

### Task 1: Control-plane signing store + new error codes

**Files:**
- Create: `apps/backend/src/services/nodes/control-keys.ts`
- Modify: `packages/backend-errors/src/error-codes.ts` (add codes)
- Create: `apps/backend/src/services/nodes/__tests__/control-keys.test.ts`

**Interfaces:**
- Consumes: `generateControlKeys`, `signCommand`, `NODE_CMD_ISSUER` from `@internal/session-protocol` (frozen in phase 0); `SESSION_DATA_DIR` from `@/constants.js`.
- Produces: `loadControlKeys(): Promise<ControlKeyPair>` (singleton; lazily generates + persists `<SESSION_DATA_DIR>/node-signing.json` mode 0600 — mirrors `mcp/identity-store.ts` fail-closed rules: corrupt file = throw, never silently regenerate, because regenerating orphans every enrolled node); `publicJwkJson(): Promise<string>` (serialized for the enroll response). Error codes (exact strings): `NODE_OFFLINE`, `NODE_UNREACHABLE`, `NODE_LAUNCH_NOT_READY`, `SETUP_KEY_INVALID`, `SETUP_KEY_EXPIRED`, `SETUP_KEY_CONSUMED`.

- [ ] **Step 1: Failing test** — `control-keys.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { IS_TEST } from "@/constants.js";
import { loadControlKeys, resetControlKeysForTests } from "../control-keys.js";

describe("control keys store (spec §4)", () => {
  beforeAll(() => { if (!IS_TEST) throw new Error("test-only: SESSION_DATA_DIR must be temp"); });

  it("generates, persists 0600, and reuses the same keypair", async () => {
    resetControlKeysForTests();
    const a = await loadControlKeys();
    const b = await loadControlKeys();
    expect(a.publicJwk).toEqual(b.publicJwk);
    expect(a.privateJwk.kty).toBe("EC");
    expect(typeof a.privateJwk.d).toBe("string");
    expect(a.publicJwk.d).toBeUndefined(); // public half never leaks d
    const file = Bun.file(`${process.env.MOTE_TEST_DATA_DIR ?? ""}/node-signing.json`);
    void file; // path asserted via reload below, not env assumptions
  });

  it("corrupt file fails closed (never silently regenerates)", async () => {
    resetControlKeysForTests();
    await loadControlKeys(); // create
    // Corrupt via the module's own path: locate by re-reading through a fresh load after tamper.
    // (Implementation note: the store keeps no partial state — a torn write must reject.)
    resetControlKeysForTests();
    // The test writes garbage into <SESSION_DATA_DIR>/node-signing.json then expects a throw:
    const { SESSION_DATA_DIR } = await import("@/constants.js"); // static in real file — see note
    void SESSION_DATA_DIR;
  });
});
```

**Correction (no dynamic imports anywhere, including tests):** write the corrupt-file case with a STATIC import of `SESSION_DATA_DIR` at the top and `import { chmod, writeTextFile } from "node:fs/promises"`; write `"garbage"` into `${SESSION_DATA_DIR}/node-signing.json`, `resetControlKeysForTests()`, then `expect(loadControlKeys()).rejects.toThrow(/node-signing/)`; afterwards restore by deleting the file and reloading fresh (so suite ordering is safe). Also chmod-assert the created file mode is `0o600` (POSIX).

- [ ] **Step 2: RED** — `cd apps/backend && bun test src/services/nodes/__tests__/control-keys.test.ts` → unresolved import.

- [ ] **Step 3: Implement `control-keys.ts`:**

```ts
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type ControlKeyPair, generateControlKeys } from "@internal/session-protocol";
import { SESSION_DATA_DIR } from "@/constants.js";

/**
 * Control-plane command-signing keypair (spec 2026-08-31 §4). ES256, generated
 * lazily at first use, persisted as a JWK FILE at 0600 — deliberately outside
 * the DB (databases get dumped more casually than this dir, which already
 * holds 0600 secrets). Losing this file orphans every enrolled node: a corrupt
 * file FAILS CLOSED (throws) rather than silently minting a new identity.
 */
const KEY_PATH = `${SESSION_DATA_DIR}/node-signing.json`;

let cached: ControlKeyPair | undefined;

/** Load (or generate-once-and-persist) the control keypair. Singleton per process. */
export async function loadControlKeys(): Promise<ControlKeyPair> {
  if (cached) return cached;
  const file = Bun.file(KEY_PATH);
  if (await file.exists()) {
    let parsed: unknown;
    try {
      parsed = await file.json();
    } catch (err) {
      throw new Error(`refusing to start node signing: ${KEY_PATH} is corrupt (${String(err)})`);
    }
    if (
      typeof parsed !== "object" || parsed === null ||
      !("publicJwk" in parsed) || !("privateJwk" in parsed)
    ) {
      throw new Error(`refusing to start node signing: ${KEY_PATH} has an unexpected shape`);
    }
    cached = parsed as ControlKeyPair;
    return cached;
  }
  const fresh = await generateControlKeys();
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  await Bun.write(KEY_PATH, JSON.stringify(fresh, null, 2));
  chmodSync(KEY_PATH, 0o600);
  cached = fresh;
  return fresh;
}

/** The public half serialized for the enroll response (agents pin this). */
export async function controlPublicJwkJson(): Promise<string> {
  return JSON.stringify((await loadControlKeys()).publicJwk);
}

/**
 * Clears the in-process cache. Test seam only — production callers must not
 * call this; @internal.
 */
export function resetControlKeysForTests(): void {
  cached = undefined;
}
```

- [ ] **Step 4: Error codes.** In `packages/backend-errors/src/error-codes.ts` (find the `BackendErrorCodes` object/union shape and follow it) add: `NODE_OFFLINE`, `NODE_UNREACHABLE`, `NODE_LAUNCH_NOT_READY`, `SETUP_KEY_INVALID`, `SETUP_KEY_EXPIRED`, `SETUP_KEY_CONSUMED`. Rebuild the package (`turbo build` will catch it in verify-types; run `bun run build --filter=@internal/backend-errors` if you want it sooner).

- [ ] **Step 5: GREEN** — focused test, then root trio.
- [ ] **Step 6: Commit** `feat(nodes): control-plane signing keypair store (0600, fail-closed) + node error codes (spec §4)`

---

### Task 2: `ensureLocalNode()` boot seeding

**Files:**
- Create: `apps/backend/src/services/nodes/seed-local.ts`
- Modify: `apps/backend/src/index.ts` (call it after `runMigrations()`, next to default-profile seeding — find `ensureDefaultProfiles` at boot)
- Create: `apps/backend/src/services/nodes/__tests__/seed-local.test.ts`

**Interfaces:**
- Consumes: `NodesRepository` (create/findById), `NodeSharesRepository` (listForNode/replaceForNode), `ensureSystemUser()` from `@/auth/system-user.js`, `LOCAL_NODE_ID` from `@/db/types/nodes.db-types.js`.
- Produces: `ensureLocalNode(repos: { nodes: NodesRepository; shares: NodeSharesRepository }): Promise<void>` — idempotent; upserts the `local` row (owner = system user, kind `local`, os/arch from `process.platform`/`process.arch`, status `online`, name `Local`) and ensures exactly one `(granteeUserId: null, permission: "edit")` share row exists WITHOUT clobbering admin changes beyond (re)adding a missing one. Never throws for "already seeded".

- [ ] **Step 1: Failing test:** create repos over the shared test `db`; call twice; assert one `nodes` row with `id === "local"`, `kind === "local"`, and one `nodeShares` row with `granteeUserId === null`, `permission === "edit"`; delete the share row, call again → share row returns (idempotent repair); pre-seed a DIFFERENT os value, call again → row NOT overwritten (seed only fills absence; os reflects `ready`… for local it reflects boot; assert the second call did not touch `name`).

- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — shape:

```ts
import type { Kysely } from "kysely";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import type { Database } from "@/db/types/index.js";

/**
 * Seeds (or repairs) the `local` node row + its Everyone/edit share — the
 * control-plane host as a first-class node (spec 2026-08-31 §2). Boot-time,
 * idempotent: a missing row or missing Everyone share is created; an admin's
 * deliberate deletions are re-created ONLY here at boot (deleting the row
 * disables local launch until restart — accepted v1 behavior, spec §2).
 */
export async function ensureLocalNode(db: Kysely<Database>): Promise<void> {
  const nodes = new NodesRepository(db);
  const shares = new NodeSharesRepository(db);
  const ownerUserId = await ensureSystemUser();
  const now = new Date().toISOString();
  if (!(await nodes.findById(LOCAL_NODE_ID))) {
    await nodes.create({
      id: LOCAL_NODE_ID,
      ownerUserId,
      name: "Local",
      kind: "local",
      os: process.platform === "darwin" ? "darwin" : "linux",
      arch: process.arch,
      hostname: (Bun.hostname ?? "localhost").replace(/\.local$/, "") || "localhost",
      status: "online",
    });
  }
  const existing = await shares.listForNode(LOCAL_NODE_ID);
  if (!existing.some((s) => s.granteeUserId === null)) {
    await shares.replaceForNode(
      LOCAL_NODE_ID,
      [...existing.map((s) => ({ granteeUserId: s.granteeUserId, permission: s.permission })), { granteeUserId: null, permission: "edit" as const }],
      ownerUserId,
    );
  }
}
```

Adjust to the actual `create` payload typing (`NewNode` optionals) and `Bun.hostname`'s real name (`Bun.hostname` may be a function — check types; fallback: `process.env.HOSTNAME ?? "localhost"`). In `index.ts` boot: `await ensureLocalNode(db);` right after migration/profile seeding (static import).

- [ ] **Step 4: GREEN + trio.** — [ ] **Step 5: Commit** `feat(nodes): seed the local node + Everyone/edit share at boot (spec §2)`

---

### Task 3: `node-access.ts` — the one authorization question

**Files:**
- Create: `apps/backend/src/lib/node-access.ts`
- Create: `apps/backend/src/lib/__tests__/node-access.test.ts`

**Interfaces:**
- Consumes: `NodeSharesRepository`, `NodesRepository`, `UserMetaRepository`, `NodeSharePermission`.
- Produces (spec §2 mapping — the capability rule, NOT the session rule):
  - `type NodeAccess = "owner" | "edit" | "view" | "none"`
  - `resolveNodeAccess(viewerId, isAdmin, node: { id; ownerUserId }, shares): NodeAccess` — owner wins outright; **admins resolve to `edit` on ANY node** (spec §1: "admins hold instance-wide edit but never delete/re-share" — delete/shares stay owner-only, enforced at the ROUTES via `nodeCanManage`, not in the resolver); else the highest of Everyone/named grants; else `none`.
  - `nodeCanLaunch(access): boolean` — `access !== "none"` (ANY level grants launch — §2 decision)
  - `nodeCanConfigure(access): boolean` — `access === "owner" || access === "edit"`
  - `nodeCanManage(access): boolean` — `access === "owner"` (plus local special-case handled at routes)
  - `loadNodeAccess(deps, viewerId, nodeId, opts?: { allowAdminAndShares?: boolean }): Promise<{ row: NodeTable | undefined; access: NodeAccess }>` — mirrors `loadSessionAccess` semantics exactly (missing = `{undefined,"none"}`; `allowAdminAndShares:false` for machine actors → owner-match only, no grants, no admin boost).

- [ ] **Step 1: Failing pure-resolver tests** (clone the structure of `apps/backend/src/lib/__tests__/session-access.test.ts` if present — check `ls`): owner→owner; admin on foreign→edit; Everyone/view + named/edit → edit wins; Everyone/view alone → view; no grant → none; viewer==owner beats admin.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** (clone `session-access.ts` verbatim in shape: RANK map, pure resolver, loader over the three repos — the ONLY semantic deltas are the three capability predicates + a JSDoc block stating: "any share grants launch; edit/owner grants config; delete+shares require owner — except the seeded `local` node, whose shares/config admins manage (spec §2)").
- [ ] **Step 4: GREEN + trio** — [ ] **Step 5: Commit** `feat(nodes): node-access resolver — any share launches, edit configures (spec §2)`

---

### Task 4: apikey-store `node` kind + auth-guard explicit rejection

**Files:**
- Modify: `apps/backend/src/auth/apikey-store.ts` (vocabulary)
- Modify: `apps/backend/src/api/auth-guard.ts` (rejection branch in the bearer path)
- Modify: `apps/backend/src/api/__tests__/auth-guard-bearer.test.ts` (or sibling) — add the rejection case

**Interfaces:**
- Consumes: nothing new.
- Produces: `ApiKeyKind = "session" | "system" | "node"`; `NodeKeyMetadata { kind: "node"; nodeId: string }`; guard behavior: a `kind:"node"` bearer 401s on EVERY `/api/*` route with a `console`-free explicit branch (`UnauthorizedError` carrying a "node keys authenticate /ws/node only" message).

- [ ] **Step 1: Failing test** — mint a raw apikey row the way the enroll flow will (`auth.api.createApiKey` with `metadata: { kind: "node", nodeId: "n1" }`, `referenceId` = any real user); call `GET /api/sessions` with it; expect 401. (Insert via `auth.api` + follow `auth-guard-bearer.test.ts` fixtures for cookie/session key setup.)
- [ ] **Step 2: RED** — today it falls through to the system-user check and 401s "by accident"; write the test to also assert the ERROR MESSAGE names node keys (distinguishes from the accidental path) so the explicit branch is pinned.
- [ ] **Step 3: Implement** — in `apikey-store.ts` extend the kind union + metadata interface (JSDoc: "node keys NEVER touch REST — auth-guard rejects them; /ws/node verifies them directly (spec §5.5)"). In `deriveFromApiKey`, right after the session-kind branch, before the system-owner check:

```ts
if (meta.kind === "node") {
  // Explicit, permanent rejection (spec 2026-08-31 §5.5): a node key's blast
  // radius is exactly "open /ws/node as that node". Do NOT widen this.
  throw new UnauthorizedError("Node keys cannot be used on the REST API");
}
```

- [ ] **Step 4: GREEN + trio** (system/session key tests unchanged) — [ ] **Step 5: Commit** `feat(auth): "node" api-key kind with explicit REST rejection (spec §5.5)`

---

### Task 5: Setup-key routes (`/api/nodes/setup-keys`)

**Files:**
- Create: `apps/backend/src/api/nodes/index.ts` (prefix aggregator, `computeRoutes` mount)
- Create: `apps/backend/src/api/nodes/create-setup-key.route.ts`, `list-setup-keys.route.ts`, `delete-setup-key.route.ts`
- Modify: `apps/backend/src/api/routes.ts` (`.use(nodesRoutes)` in `computeRoutes`)
- Modify: `apps/backend/src/db/repositories/node-setup-keys.repository.ts` (add `peekValid(plaintext): Promise<boolean>` — SELECT by hash, unconsumed+unexpired, NO flip — for the download gate later)
- Create: `apps/backend/src/api/nodes/__tests__/setup-keys-route.test.ts`

**Interfaces:**
- Consumes: `authGuard` (cookie human path), `NodeSetupKeysRepository` (create/list/deleteById), `audit`, `requireCookieActor` from `auth-guard`.
- Produces REST (spec §9): `POST /api/nodes/setup-keys {label} → { id, key, expiresAt }` (plaintext once); `GET /api/nodes/setup-keys → { keys: [{id,label,createdAt,expiresAt,usedAt,consumedNodeId}] }` (own user's, newest first); `DELETE /api/nodes/setup-keys/:id → {ok}` (own only). All writes cookie-only (machine actors 403 via `requireCookieActor`). Audit `setup_key.create` / `setup_key.revoke`.

- [ ] **Step 1: Failing route tests** (clone `__tests__/helpers/auth-tables.ts` + `signIn`/`authedRequest` per existing route tests): create returns `nsk_`-prefixed key + list shows it WITHOUT the secret (assert list body does not contain the plaintext); delete own → gone; delete other user's key → 0 rows affected → 404; session-kind bearer → 403.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — per-endpoint Elysia files in the system-keys shape (bodies/responses with descriptions, operationIds `createNodeSetupKey`/`listNodeSetupKeys`/`deleteNodeSetupKey`, tags `["nodes"]`), aggregated by `src/api/nodes/index.ts`: `new Elysia({ prefix: "/api/nodes" }).use(createSetupKeyRoute)…`. Owner scoping from `ctx.user.id`. Label: `t.String({ minLength: 1, maxLength: 64 })`.
- [ ] **Step 4: Add `peekValid`** to the repo (single SELECT, `usedAt is null`, `expiresAt > now`) + one repo test.
- [ ] **Step 5: GREEN + trio (+ turbo build for treaty re-infer)** — [ ] **Step 6: Commit** `feat(api): node setup-key routes (single-use, cookie-only, audited)`

---

### Task 6: Enroll route (`POST /api/nodes/enroll`)

**Files:**
- Create: `apps/backend/src/api/nodes/enroll.route.ts`
- Modify: `apps/backend/src/api/nodes/index.ts` (mount)
- No repository changes needed (use `findById` for existence; the per-owner name uniqueness comes from the `idx_nodes_owner_name` unique index)
- Create: `apps/backend/src/api/nodes/__tests__/enroll-route.test.ts`

**Interfaces:**
- Consumes: `NodeSetupKeysRepository.consume`, `NodesRepository.create/setApiKeyId`, `NodeSharesRepository` (seed `owner→owner` implicit; no shares needed), `identities` insert (direct Kysely `insertInto("identities")` or `IdentitiesRepository` — check its methods) with `assertImportablePublicJwk` from `@/api/public-jwk.js`, `auth.api.createApiKey` (`metadata: { kind:"node", nodeId }`, `permissions: { nodes:["read","write"] }`, no `expiresIn`), `controlPublicJwkJson()`, `apiErrorBody` + the SETUP_KEY_* codes, `APP_BASE_URL` + `SERVER_PORT` from constants (wsUrl), `audit`.
- Produces: public POST (NO authGuard — the setup key is the credential), body `{ setupKey, name, os, arch, hostname, agentVersion, publicKey }` (publicKey = stringified JWK). Success `201 → { nodeId, nodeKey, controlPublicKey, wsUrl }` where `wsUrl = ws(s)://<host>/ws/node` derived from `APP_BASE_URL` (https → wss). Failure codes: `SETUP_KEY_INVALID/EXPIRED/CONSUMED` (401 with structured body; map consume()'s null + reason by re-checking `peekValid`… simplest: consume() returning null → 401 `SETUP_KEY_INVALID` with message "invalid, expired, or already used" — one honest code, spec lists all three; document). Name uniqueness: owner+name unique index → catch → 409 "You already have a node named X". Order of writes (crash-safe): consume key (transaction) → insert `nodes` row (id = randomUUID, owner = key owner, status offline) → insert identity `node:<id>` → mint api key → `setApiKeyId`. If any step after consume throws, the key stays consumed (honest: retry = new key; record that in the JSDoc).

- [ ] **Step 1: Failing tests** — happy path via real setup key: 201; assert node row (owner = creator), identity row principal `node:<id>` with importable JWK, returned `nodeKey` starts `mote_` and `nodes.apiKeyId` set; `peekValid(key)` now false. Reuse → 401. Bad key → 401. PublicKey garbage → 400 and NO row churn (validate `assertImportablePublicJwk` + os/arch/name BEFORE consuming — validate-first ordering is testable: bad publicKey leaves the key unconsumed). Duplicate name → 409.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** per the order above; validate-before-consume: parse+assert JWK importable, `os ∈ {"linux","darwin","unknown"}` (mirror the wire validator), `arch`/`hostname`/`name` string lengths (label-style caps), THEN consume. Use `HttpError`/`apiErrorBody` consistent with `uploads.route.ts` return-path style for 4xx.
- [ ] **Step 4: GREEN + trio + turbo build** — [ ] **Step 5: Commit** `feat(api): node enrollment — setup-key redemption, identity + node key mint (spec §5.2)`

---

### Task 7: Node registry + RPC skeleton

**Files:**
- Create: `apps/backend/src/services/nodes/node-registry.ts`
- Create: `apps/backend/src/services/nodes/node-rpc.ts`
- Create: `apps/backend/src/services/nodes/__tests__/node-rpc.test.ts`

**Interfaces:**
- Consumes: `signCommand` + `NODE_PROTOCOL_VERSION`/`NodeCommandBody`/`parseNodeEvent` from `@internal/session-protocol`; `loadControlKeys`; a `WsLike` socket shape `{ send(data: string): void; close?(code?, reason?): void }` (same shim discipline `ws/session-ws.ts` uses for `WsSocket`).
- Produces (frozen for phase 2's `RemoteLauncher`):
  - registry: `attachConnection(nodeId, conn: { ws; seq: number; jtiLru; ... })`, `getLive(nodeId): Connection | undefined`, `detachConnection(nodeId, ws)`, `listOnline(): string[]` — module-scope Map, newest-wins: attaching an existing nodeId closes the OLD socket with `4409` first (spec §5.3).
  - rpc: `sendCommand(nodeId: string, cmd: NodeCommandBody, timeoutMs = 10_000): Promise<unknown>` — assigns `jti = crypto.randomUUID()` and `seq = ++conn.seq`, signs the envelope, sends `{ jws }`, resolves with the `result.data` on `{type:"result", ref: jti, ok:true}` / rejects `NodeRpcError` (`code: "offline" | "unsupported" | "failed" | "timeout"`) otherwise; pending map `jti → {resolve,reject,timer}`; `resolveResult(event: NodeEvent & {type:"result"})` fed by the ws handler; `failAllFor(nodeId, reason)` on socket close (reject pendings `offline`/`unreachable`).

- [ ] **Step 1: Failing tests** — register a fake connection object capturing `send`; `sendCommand("n1",{type:"ping"},5000)`: rejects `offline` when absent; rejects `unsupported` when fake replies `{type:"result",ref:<captured jti>,ok:false,error:"unsupported"}`; resolves with `data` on ok; rejects `timeout` on a 50ms timeout; newest-wins close called with 4409; seq increments monotonically across sends. Unwrap the sent JWS with `verifyCommand` + the control public key in the test to prove the envelope is correct (aud/exp/seq/jti match).
- [ ] **Step 2: RED.** — [ ] **Step 3: Implement** — [ ] **Step 4: GREEN + trio** — [ ] **Step 5: Commit** `feat(nodes): live-socket registry + signed RPC (sendCommand ↔ result-by-jti)`

---

### Task 8: `/ws/node` handler + offline projection

**Files:**
- Create: `apps/backend/src/services/nodes/node-ws-handler.ts`
- Modify: `apps/backend/src/ws/ws.plugin.ts` (second `.ws("/ws/node", …)` with the `upgrade()` hook)
- Modify: `apps/backend/src/index.ts` (60 s sweep: mark `online` nodes with stale heartbeats offline)
- Modify: `apps/backend/src/api/nodes/enroll.route.ts` response? (no — wsUrl already) 
- Create: `apps/backend/src/services/nodes/__tests__/node-ws-handler.test.ts`

**Interfaces:**
- Consumes: `verifyApiKey` (`auth.api.verifyApiKey({ body: { key } })`), `NodesRepository` (findById/applyReady/applyInventory/touch/setStatus/applyInventory), `NodeHarnessesRepository` (for inventory gating), `nodeRegistry`/`node-rpc` (`resolveResult`, `failAllFor`), `parseNodeEvent`, `NODE_PROTOCOL_VERSION`, `NODE_MAX_FRAME_BYTES`, `getRequestlessContext()` (ws handlers use it — see `ws/session-ws.ts`).
- Produces: upgrade path — `upgrade(req)` (Spike first, see step 1) verifies the bearer key synchronously-if-possible else stash-and-verify-in-`open`; on auth success `upgrade` returns `{ nodeId, apiKeyId }` into `ws.data`; auth failure → HTTP refusal pre-socket if the hook allows it, otherwise close 4401 (the spike records which; errata the spec §5.3 line if HTTP turns out impossible — the SPIKE RESULT goes in the report). `open`: load node row (404→close 4401), enabled-key link check `nodes.apiKeyId === apiKeyId` (mismatch → close 4403), attach to registry (newest-wins 4409 on the old), mark `applyReady` on first `ready` frame, `protocolVersion` mismatch → close 4406. `message`: byte-length cap → drop+close(1009); `parseNodeEvent` null → ignore (log debug); `ready`/`heartbeat` → touch/status online; `inventory` → `applyInventory(nodeId, JSON.stringify(harnesses))` + (Task 10) seed gate; `result` → `resolveResult`; `exit`/`sessions_report`/`output` → ignored in phase 1 with a debug line (phase 2 consumes). `close`: `failAllFor` + `detachConnection` + if this socket was current → `setStatus(offline)`. Sweep: in the existing 60 s tick add `markStaleNodesOffline(45_000)` — new repo method `NodesRepository.markStale(status="online", olderThanMs) → count` (UPDATE … WHERE status='online' AND lastSeenAt < now-45s AND kind='agent' — local excluded).

- [ ] **Step 1: SPIKE (before tests, in a scratch file, delete after):** confirm what Elysia 1.4.29's `.ws` `upgrade()` hook can do — read `node_modules/.../elysia/dist/ws/types.d.ts` (you'll see `upgrade?: Record | ((context: Context) => unknown)`), then empirically: does a GET `/ws/node` with an `Authorization` header reach `upgrade` with `request`/`headers` in context, and can it REJECT (return false/`Response`) to produce an HTTP failure vs a socket close? Record findings in the report; pick the auth placement the platform actually supports (spec's HTTP-refusal tier is the target; if impossible, pre-registry verify in `open` with close 4401/4403 and file a one-line spec erratum in this task's docs touch).
- [ ] **Step 2: Failing tests** — drive `handleNodeWs` directly with a scripted fake socket (mirror `session-ws.test.ts` fakes): bad key → refused; node-key mismatch → 4403 path; happy: connect → `ready` → row online + fields persisted; `inventory` frame → `inventoryJson` persisted; unknown frame ignored; second attach closes first with 4409; close → status offline + `failAllFor`; oversized message dropped. Plus the sweep repo test (stale flipped, fresh + local untouched).
- [ ] **Step 3: RED.** — [ ] **Step 4: Implement** the handler as a plain exported functions set (`verifyUpgrade(headers): {nodeId, apiKeyId} | null`, `handleNodeOpen/Message/Close`) so tests skip the HTTP layer; wire `.ws("/ws/node", {...})` in `ws.plugin.ts` next to `/ws` reading `ws.data`.
- [ ] **Step 5: GREEN + trio** — [ ] **Step 6: Commit** `feat(ws): /ws/node enrollment socket — verify/ready/heartbeat/inventory, offline sweep (spec §5.3)`

---

### Task 9: Node CRUD + shares + rotate-key

**Files:**
- Create under `apps/backend/src/api/nodes/`: `list-nodes.route.ts`, `get-node.route.ts`, `rename-node.route.ts`, `delete-node.route.ts`, `get-node-shares.route.ts`, `set-node-shares.route.ts`, `rotate-node-key.route.ts`
- Modify: `apps/backend/src/api/nodes/index.ts`, `apps/backend/src/db/repositories/nodes.repository.ts` (add `countRunningSessions(nodeId)` via sessions join)
- Create: `apps/backend/src/api/nodes/__tests__/nodes-crud-route.test.ts`, `node-shares-route.test.ts`

**Interfaces:**
- Consumes: `authGuard`, `loadNodeAccess`/`nodeCanConfigure`/`nodeCanManage` (Task 3), repo methods from phase 0, `setApiKeyEnabled`/`deleteApiKey` from `apikey-store`, `audit`.
- Produces (spec §9):
  - `GET /api/nodes` → `{ nodes: NodeView[] }` where NodeView = `{ id, name, kind, os, arch, hostname, status, lastSeenAt, agentVersion, access, capabilities: string[], harnesses: {harnessId, enabled, installed, version?}[] }` — visible = `findAccessible`; `harnesses` merged from ALL_HARNESSES × (local: harnessPlugins+probe; agent: node_harnesses rows + inventory — Task 10 builds the merge; until then return raw rows, Task 10 refines IN ITS OWN commit). `GET /api/nodes` also allows bearer session-key actor with sharing/admin-boost OFF (owner-match, per session-rule precedent) — or RESTRICT to cookie for phase 1 (simpler, honest): **cookie-only for phase 1; note "bearer read deferred until a machine consumer exists"** in the JSDoc. (Chosen: cookie-only — YAGNI.)
  - `GET /api/nodes/:id` → 404 when `access==="none"`, else NodeView + `shares` (owner/config-capable only).
  - `PATCH /api/nodes/:id` `{name}` — owner (or admins on `local`); 409 on per-owner name collision; `local` name immutable (400).
  - `DELETE /api/nodes/:id` — owner only (`local` → 400); `409 { running sessions }` unless `?force=true` (phase 1: force only when none online — remote terminate is phase 2; if the node is offline, proceed); disables + deletes the api key, `deleteById` (unpins profiles), audit.
  - `GET/PUT /api/nodes/:id/shares` — owner-only cookie (admins manage `local`'s); PUT body `{shares:[{granteeUserId, permission}]}` (same contract as session-shares) — for `local`, PUT is admin-cookie-gated and accepts ANY valid list but the UI only ever toggles Everyone/edit.
  - `POST /api/nodes/:id/rotate-key` — owner cookie (admins for `local`); mints new key, `setApiKeyEnabled(old,false)`, flips `apiKeyId` after the new key exists, returns `{ nodeKey }` once; agent must be re-configured manually (message says so).
- [ ] **Step 1: Failing tests** (fixtures: two users, one agent node each + local seeded): invisible 404 vs visible list; view-grantee sees the node in GET and list, cannot PATCH shares (403), CANNOT configure (403 — config gate asserted via the shares PUT and Task-10's harness PATCH); delete by admin (non-owner) 403; delete by owner cascades api-key disable (assert `apikey.enabled` via `isSystemKey`-style raw probe or repo helper); rotate rotates + old key fails `verifyApiKey`; local rename → 400; local shares PUT by non-admin 403, by admin works.
- [ ] **Step 2: RED** — [ ] **Step 3: Implement** (each route its own file; shared `nodeView(repo…, harnessRows…)` helper in `api/nodes/node-view.ts` to avoid duplication) — [ ] **Step 4: GREEN + trio + turbo build** — [ ] **Step 5: Commit** `feat(api): node registry CRUD, shares, key rotation (spec §9)`

---

### Task 10: Per-node harness availability + inventory-backed views

**Files:**
- Modify: `apps/backend/src/api/harness-utils.ts` (node-aware overloads)
- Create: `apps/backend/src/api/nodes/patch-node-harness.route.ts`, `recheck-node.route.ts`
- Modify: `apps/backend/src/api/nodes/node-view.ts` (harnesses merge), `apps/backend/src/api/nodes/index.ts`
- Modify: `apps/backend/src/services/default-profiles.ts` only if a reusable per-user-per-harness seeder already exists — call `ensureDefaultProfilesForHarness` on enable (same as setup route does)
- Create: `apps/backend/src/api/nodes/__tests__/node-harnesses-route.test.ts`
- Create: `apps/backend/src/services/nodes/inventory.ts` — `effectiveHarnessStates(node: NodeTable): Promise<{harnessId, enabled, installed, version?}[]>` merging `node_harnesses` rows + `scanHarnesses`-shaped inventory (agent) or plugin probes (local); TTL rule: inventory older than 10 min reports `installed` with a `stale: true` addition to the view type.

**Interfaces:**
- Consumes: `ALL_HARNESSES`, `NodeHarnessesRepository`, `nodeCanConfigure`, `sendCommand` (recheck → `sendCommand(nodeId, {type:"inventory"})`, `409 NODE_OFFLINE`/`NODE_UNREACHABLE` mapped from `NodeRpcError.code`; agent replies inventory AND the handler already persisted it — the recheck route returns `{ ok: true }` after the result resolves).
- Produces: `harnessUsable(harnessId, nodeId?)` — default `"local"` → today's behavior verbatim; agent nodes → row-enabled (or plugin default) ∧ inventory says installed. Existing zero-arg callers keep compiling (search `harnessUsable(`/`usableHarnessIds(` — profiles filtering stays LOCAL-scoped in phase 1 by design: a profile usable anywhere still gates on local; add a one-line comment pointing at phase-2 launch gating).

- [ ] **Step 1: Failing tests** — node view harnesses for an agent node: inventory JSON seeded on the row → chips reflect inventory + enabled overrides; enable on not-installed harness → 409; enable → seeds Default profile (assert a Default row appeared for the toggler… ensureDefaultProfilesForHarness is per-user — reuse exactly what setup.route.ts calls, and assert its effect the same way its tests do); recheck on offline node → 409 NODE_OFFLINE; local node PATCH harness keeps today's setup-route semantics through the new route (or do NOT expose local here — decision: expose, access = `nodeCanConfigure` which includes everyone via Everyone/edit — preserving today's any-cookie-user behavior; `PATCH /api/setup/harnesses/:id` stays as-is for the settings card this phase, both paths must agree — assert).
- [ ] **Step 2: RED** — [ ] **Step 3: Implement** — [ ] **Step 4: GREEN + trio + turbo** — [ ] **Step 5: Commit** `feat(nodes): per-node harness state + inventory-backed views + recheck (spec §6.2)`

---

### Task 11: Downloads + install script

**Files:**
- Create: `apps/backend/src/api/downloads.route.ts`
- Modify: `apps/backend/src/constants.ts` (`NODE_ARTIFACTS_DIR`, default `${SESSION_DATA_DIR}/node-artifacts`, env-overridable `MOTE_NODE_ARTIFACTS_DIR`)
- Modify: `apps/backend/src/server.ts` (root-level `GET /install.sh` BEFORE the static SPA plugin; `/api/downloads` into `coreRoutes` in `routes.ts`)
- Create: `apps/backend/src/api/__tests__/downloads-route.test.ts`

**Interfaces:**
- Consumes: `NodeSetupKeysRepository.peekValid` (setup-key gate), cookie path via authGuard-optional pattern (`resolveSetupActor`-style probe used by `setup.route.ts` — reuse the established "cookie OR public-with-probe" idiom), `Bun.file`, `crypto.subtle.digest`.
- Produces: `GET /api/downloads/node/:target` where target ∈ `{linux-x64,linux-arm64,darwin-x64,darwin-arm64}` (closed enum in the `t` schema; 404 otherwise) + `GET /api/downloads/node/:target.sha256` (computed, cached by `${path}:${mtimeMs}` in a module Map); auth = cookie session OR `?setup_key=` valid-and-unconsumed; `GET /install.sh?setup_key=…` → `text/plain` script: `set -euo pipefail`; detect `uname -s/-m` → target triple; `curl -fsSL "$SERVER/api/downloads/node/$TARGET?setup_key=$KEY" -o mote-agent`; fetch `.sha256` and verify (`sha256sum -c` or `shasum -a 256 -c`); `chmod +x`; exec `./mote-agent enroll --server "$SERVER" --key "$KEY"`; then print the next-step (`./mote-agent run`). Server URL baked from `APP_BASE_URL`. When the key is absent/invalid the script renders a usage error only (exit 2).

- [ ] **Step 1: Failing tests** — no auth + no key → 401 JSON on the binary route, usage-error script on `/install.sh`; valid setup key → 200 with the key redacted from any echoed strings (never echo the key into the script body outside the `$KEY` variable assignment… it must appear for enroll — accept: it was in the URL to begin with, spec §11 posture); unknown target → 404; binary missing on disk → 404 `ApiErrorResponse`; sha endpoint returns 64-hex for a fixture file placed in a temp `NODE_ARTIFACTS_DIR` (override via env BEFORE import — use a test that writes the dir path from `NODE_ARTIFACTS_DIR` directly).
- [ ] **Step 2: RED** — [ ] **Step 3: Implement** — [ ] **Step 4: GREEN + trio + turbo** — [ ] **Step 5: Commit** `feat(api): agent artifact downloads (cookie-or-setup-key gated) + rendered install.sh (spec §8)`

---

### Task 12: `apps/agent` scaffold + config store + `enroll` command

**Files:**
- Create: `apps/agent/package.json`, `tsconfig.json`, `bunfig.toml`, `src/main.ts`, `src/cli.ts`, `src/config.ts`, `src/identity.ts`, `src/enroll.ts`, `src/test-preload.ts`
- Modify: root `package.json` (workspaces already `apps/*` — verify), `turbo.json` only if tasks aren't inherited (check `extends`), `.gitignore` (agent dist)

**Interfaces:**
- Consumes: `@internal/harnesses` (`scanHarnesses`, tmux check via `spawnSync(["tmux","-V"])`), `@internal/session-protocol` types.
- Produces:
  - Config at `${MOTE_AGENT_HOME ?? ~/.config/mote-agent}/config.json` 0600: `{ serverUrl, nodeId, nodeKey, controlPublicKey, dataDir, name }` (JSDoc'd interface `AgentConfig`); `loadConfig(): Promise<AgentConfig>` (throws actionable error when missing → "run mote-agent enroll"); `saveConfig()` writes 0700 dir + 0600 file + verifies mode.
  - Identity: `loadOrCreateIdentity(dataDir)` → P-256 keypair JWK file `<dataDir>/identity.json` 0600 (mirror `mcp/identity-store.ts` fail-closed rules; reuse its quarantine wording, do NOT import from backend — small verbatim-copy allowed, note "port of backend mcp/identity-store.ts" in the header, and keep it <80 lines).
  - CLI: `mote-agent enroll --server <url> --key <nsk_…> [--name n] [--data-dir d] | run | status [--json] | version`. Hand-rolled arg parse (~40 lines: map flags → record). `enroll`: preflight tmux (fail with "tmux not found — on macOS: brew install tmux"); generate identity; `POST <server>/api/nodes/enroll` with `{setupKey, name (hostname default), os: process.platform-mapped, arch, hostname, agentVersion, publicKey}`; map 401→"setup key invalid/expired/used", 409→name hint; on success save config (0600), print `Enrolled as <nodeId> — next: mote-agent run`. `version` prints `0.1.0` + protocol version.
- [ ] **Step 1: Failing tests** (`src/__tests__/config.test.ts`, `enroll.test.ts` — preload sets `MOTE_AGENT_HOME` to mkdtemp): save→load round-trip + mode 0600 (skip mode assert on non-POSIX guard `process.platform !== "win32"` — targets never include win anyway, keep assert unconditional); loadConfig throws /enroll/ when absent; enroll against a LOCAL FAKE control plane: spin `Bun.serve` with the enroll endpoint echoing canned `{nodeId, nodeKey, controlPublicKey, wsUrl}` — assert config persisted + exit 0; fake 401 → actionable message, no config written. Identity: second load reuses the same JWK; corrupt file throws (never regenerates) and quarantines.
- [ ] **Step 2: RED** — [ ] **Step 3: Implement scaffold** — package.json:

```json
{
  "name": "@internal/agent",
  "description": "mote-agent — node daemon: enrolls with the control plane and executes signed commands",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsdown",
    "build:dev": "hash-runner",
    "clean": "rm -rf .turbo node_modules dist .hashes.json",
    "lint": "biome check --write --unsafe src && biome format src --write && biome lint src --fix",
    "lint:check": "biome check --no-errors-on-unmatched src",
    "lint:staged": "biome check --no-errors-on-unmatched --write --unsafe --staged src",
    "test": "bun test",
    "verify-types": "tsc --project tsconfig.json --noEmit",
    "compile": "bun build --compile --bytecode --minify --sourcemap ./src/main.ts --outfile ./dist/mote-agent"
  },
  "dependencies": { "@internal/harnesses": "workspace:*", "@internal/session-protocol": "workspace:*" },
  "devDependencies": { "@internal/tsconfig": "workspace:*", "@types/bun": "1.3.14", "hash-runner": "4.0.0", "tsdown": "0.22.14", "typescript": "7.0.2" }
}
```

`bunfig.toml`: `[test] preload = ["./src/test-preload.ts"]`; preload sets `MOTE_AGENT_HOME` to a fresh `mkdtempSync` + `process.env.MOTE_TEST_MODE = "1"`. tsdown config mirroring session-protocol's (entry `src/main.ts`? — for the agent, tsdown builds a lib for type-checked imports; the binary path is `compile`. Keep `build: tsdown` with entry `src/index.ts` re-exporting config/identity for testability).
- [ ] **Step 4: GREEN + root trio (the new workspace must be picked up by `bun run verify-types`/`test` — check the root scripts glob and add the package if globs are explicit)** — [ ] **Step 5: Commit** `feat(agent): apps/agent scaffold — 0600 config store, identity keypair, enroll command`

---

### Task 13: Agent daemon (`run`)

**Files:**
- Create: `apps/agent/src/daemon.ts`, `src/backoff.ts`, `src/inventory.ts`, `src/__tests__/daemon.test.ts`, `src/__tests__/backoff.test.ts`

**Interfaces:**
- Consumes: config/identity (Task 12), `verifyCommand`/`JtiLru`/`SeqTracker`/`parseNodeCommandBody`… (protocol), `scanHarnesses`, `NODE_PROTOCOL_VERSION`, `AGENT_VERSION`.
- Produces: `runDaemon(config, deps?: { now?: () => number; rand?: () => number }): Promise<never>` — connect `new WebSocket(wsUrl, { headers: { Authorization: \`Bearer ${nodeKey}\` } })`; on open send `ready { agentVersion, protocolVersion: NODE_PROTOCOL_VERSION, os, arch, hostname, dataDir, capabilities: [] }` (no `mcp`/`uploads` yet); heartbeat every `15_000` ms `heartbeat {ts}`; inbound: byte-size guard (`new Blob([raw]).size > NODE_MAX_FRAME_BYTES` → ignore + log), `verifyCommand(jws, controlPublicKey, { nodeId, jtiLru (created once per PROCESS), seqTracker (fresh per CONNECT — reset on every 'open') })`; failure → `error` event `{code:"verify", message: reason}` + drop connection on `seq` (spec §4); verified command → execute switch: `ping`→result ok, `inventory`→fresh `scanHarnesses()` → `inventory` event + `result ok:true`, everything else → `result {ok:false, error:"unsupported"}` — every result carries `ref: claims.jti` and the `jti` idempotence map (`Map<string, result>` LRU-ish 256) so effectful replays return the cached result. Reconnect: full-jitter exponential `backoff.ts` — `delay(attempt) = rand() * min(60_000, 1000 * 2**attempt)` (pure fn, seeded-injectable for tests); on `close`: `4409`/`4406` → print + `process.exit(1)` (terminal, spec §5.3/F); else backoff→retry. `status [--json]`: reads config; opens a short-lived connect (5 s cap) reporting `online|offline|config-missing`; JSON shape `{nodeId, serverUrl, online, agentVersion}`.
- [ ] **Step 1: Failing tests** — `backoff.test.ts`: bounds + determinism with `rand=()=>1`/`()=>0`; `daemon.test.ts` with an in-process `Bun.serve` .ws fake plane: bad signature frame ignored (no result); valid `ping` envelope (signed by a test-local keypair pinned into config) → result with ok + matching ref; `launch` → unsupported; replayed jti → error path or silence (assert no double execution via handler spy); `4409` close → exits (spawn the daemon fn with injected `exit`); seq regression → socket dropped.
- [ ] **Step 2: RED** — [ ] **Step 3: Implement** — [ ] **Step 4: GREEN + trio; plus a COMPILE smoke: `cd apps/agent && bun run compile` then `./dist/mote-agent version`** (static-import discipline proof) — [ ] **Step 5: Commit** `feat(agent): mote-agent run — signed-frame loop, heartbeat/inventory, terminal 4409/4406, jittered backoff (spec §7)`

---

### Task 14: Frontend — hooks + Nodes list + Add-node flow

**Files:**
- Create: `apps/frontend/src/types/node.ts`, `apps/frontend/src/hooks/use-nodes.ts`, `apps/frontend/src/routes/nodes.tsx`, `apps/frontend/src/components/nodes/add-node-dialog.tsx`, `apps/frontend/src/components/nodes/node-row.tsx`
- Modify: `apps/frontend/src/components/app-sidebar.tsx` (`NAV_ITEMS += { to: "/nodes", label: "Nodes", ... }` — match the entry shape), `apps/frontend/src/lib/query-keys.ts` (export `NODES_QUERY_KEY = ["nodes"]`)

**Interfaces:**
- Consumes: `apiFetch`/`apiPost`, `Card`/`Dialog`/`Badge`/`StatusPill`/`ActionsMenu`/`CopyCommandRow`/`EmptyState`/`PageHeader`/`ErrorBanner`/`confirmAction` — exact import paths from `system-api-keys-card.tsx` (read it first); endpoints from Tasks 5/9.
- Produces: `Node` TS interface mirroring NodeView (Task 9's response shape — copy field names EXACTLY from `node-view.ts`); `useNodes()`, `useNode(id)`, `useDeleteNode()`, `useSetupKeys()`, `useCreateSetupKey()`, `useDeleteSetupKey()` (invalidation: `NODES_QUERY_KEY`, own keys); `NodesPage`: PageHeader + Add-node button; rows: name, OS/arch chip (`os==="darwin"?"Apple":"Linux"` + arch), `StatusPill` (online→success, offline→muted, agent-too-old→warning via agentVersion/protocol), harness chips (installed∧enabled green outline), owner ("yours"/shared badge when `access!=="owner" && access!=="none"`), ActionsMenu (Open config / Share / Delete — destructive, owner-only shown-disabled-not-hidden). `AddNodeDialog`: step 1 name → `useCreateSetupKey` → step 2 plaintext-once: `nsk_` code + rendered install command in `CopyCommandRow`: `curl -fsSL "$SERVER/install.sh?setup_key=<KEY>" | bash` (server URL = `window.location.origin`) + warning text ("shown once") + `waiting for enrollment` hint while `useNodes` refetch-interval 3 s is enabled (only while the dialog is open — `refetchInterval: (q) => open ? 3000 : false`).
- [ ] **Step 1: failing component/hook tests where the repo has a frontend test setup** — check `apps/frontend/src/**/*.test.ts` existence; the repo tests hooks/components with bun test + minimal DOM mocks? (inspect 1–2 existing frontend tests first and MIRROR their approach; if none exist for components, test the hook layer only: `use-nodes.test.ts` with `apiFetch` monkey-stubbed, per the existing pattern — if NO frontend test precedent exists, note in the report and rely on e2e in Task 16.)
- [ ] **Step 2: implement per above** — [ ] **Step 3: `cd apps/frontend && bun run verify-types && bun run test`** + root trio + `turbo build` (SPA build proves imports resolve) — [ ] **Step 4: Commit** `feat(ui): Nodes list page + setup-key/add-node flow (plaintext-once install command)`

---

### Task 15: Frontend — node detail page + shares dialog generalization + session/profile node fields + settings toggle

**Files:**
- Create: `apps/frontend/src/routes/nodes_.$id.tsx`, `apps/frontend/src/components/nodes/node-harness-card.tsx`, `apps/frontend/src/hooks/use-node-shares.ts`
- Modify: `apps/frontend/src/components/sharing-dialog.tsx` (resource-parametrize: add props `kind: "session" | "node"` + endpoint derivations — ALL existing session call sites must keep compiling unchanged: give the new props defaults or thin wrappers; decision: wrapper `NodeSharingDialog` that reuses the internals via extracted `SharingDialogCore` — do the extraction so BOTH names import the core), `apps/frontend/src/hooks/use-harnesses.ts` (add `useNodeHarnesses(nodeId)` + `useSetNodeHarnessEnabled(nodeId)` hitting `/api/nodes/:id/harnesses/:harnessId`; existing zero-arg hooks untouched), `components/session-picker/new-session-form.tsx` (+`nodeId` in value + a Node `Select` — options: nodes with `canLaunch` + online, labels `Local` / name; selecting non-local marks the form "remote launch arrives in phase 2" via inline muted text and submit still posts `nodeId: "local"`), `routes/new.tsx` + `components/session-picker/add-session-dialog.tsx` (thread the field), `components/profile-fields.tsx` + `lib/profile-form.ts` + `types/profile.ts` (node Select: `Any node` / each visible node; persist via `nodeId` on the profile payload), `routes/settings.tsx` (card: "Sessions launch on the control-plane host" toggle → PUT local shares [Everyone/edit present vs absent] admin-gated; link to `/nodes/local`), `hooks/use-recent-paths.ts` (accept optional `nodeId` → `?node=`; default undefined = today), `apps/mobile/src/types/session.ts`-adjacent mirror files (add optional `nodeId` fields where sessions are typed — mirror only, no picker).
- Backend additions in this task: `profiles.route.ts` POST/PUT accept optional `nodeId` (validate: node visible to the user via `loadNodeAccess` access `!== "none"`; `GET /api/profiles` returns it). `sessions/create-session.route.ts` accepts optional `nodeId`: `"local"`/omitted → today; anything else → `409 NODE_LAUNCH_NOT_READY` (message: "remote launch arrives in phase 2"); session list/detail responses include `nodeId`.
- [ ] **Step 1: Failing tests** — backend: profile pin/unpin + invisible-node pin → 400/404; create-session nodeId:"local" works, agent node 409 (message pinned). Frontend: whatever test layer exists per Task 14's decision.
- [ ] **Step 2: implement** — [ ] **Step 3: trio + turbo + `cd apps/frontend && bun run build`** — [ ] **Step 4: Commit** (split frontend/backend if the diff is large) `feat(ui): node config page, shares generalization, session/profile node fields; feat(api): profile pinning + phase-1 nodeId guards`

---

### Task 16: Close-out — docs, ledger, real-node smoke (user-assisted)

- [ ] Update `docs/superpowers/plans/2026-08-31-nodes.md`: mark Phase 1 tasks done with the executed-plan pointer.
- [ ] Root trio + `bun run test:e2e` (expect 21+1 — plus: if quick, extend `e2e/tests/12-nodes.spec.ts` MINIMALLY: admin sees /nodes, opens Add-node, gets a setup key + command, node list shows `Local` online; no real agent in e2e yet (that's phase 3's stub-agent spec)).
- [ ] SMOKE CHECKLIST for the human (run it, paste results): build agent binary (`bun run compile` in apps/agent), start dev backend, from the Nodes page: create key → copy install command → run `mote-agent enroll … && mote-agent run` on this machine → node appears online with chips within ~5 s; kill/restart the agent → offline→online transitions visible; `status` reflects both.
- [ ] Commit + ledger final line.

## Self-review notes (plan author)

- **Spec coverage:** §5.1→T5, §5.2→T6, §5.3→T7/T8, §5.4→T9 (delete/rotate), §5.5→T4, §5.6→T8(sweep)/T9(409s), §6.2→T10, §7→T12/T13, §8→T11, §9→T5/6/9/10/11, §10→T14/T15, §2→T2/T3. NOT in phase 1 by design: §3 launch/terminal relay (phase 2), `sessions.node_id` launch resolution (phase 2), enroll `rotate` (owner-only; agent re-config = manual paste; `enroll --rotate` UI nicety deferred), heartbeat-silence close of sockets (sweep flips status; closing the stale socket is a phase-2 nicety).
- **Type consistency:** NodeView fields are defined ONCE (Task 9 `node-view.ts`); T14's `types/node.ts` copies them verbatim — the turbo build + treaty re-infer catches drift; the wsUrl in T6 must match T13's connect path `/ws/node` (T8 mounts exactly there).
- **Placeholder scan:** T14/T15 frontend steps reference reading the real files first (system-api-keys-card, sharing-dialog) and mirror them — intentional (they're living files; the plan pins WHAT must change, the house style is the source of truth for JSX). Backend steps carry complete code.
