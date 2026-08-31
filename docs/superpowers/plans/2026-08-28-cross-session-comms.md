# Cross-Session Communication (Channels + Session Tokens + `mote mcp`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions (tmux-backed agent harnesses) communicate through E2EE shared channels and manage each other's lifecycle via a local stdio MCP server, authenticated by better-auth API keys.

**Architecture:** REST-first in the existing Elysia backend (channels/identities are new route groups; sessions gain key-auth + `prompt`). A new `mote mcp` stdio MCP server runs *inside each session*, holds the session's keypair, and is the only E2EE endpoint — the backend stores only jose General-JWE envelopes. Auth is two-tier: admin-created system keys + per-session tokens minted at `createSession` and revoked on terminate/reconcile.

**Tech Stack:** Bun, Elysia, Kysely (bun:sqlite), better-auth 1.7 + `@better-auth/api-key`, `jose` (General JWE, ECDH-ES+A256KW / A256GCM), `@modelcontextprotocol/server` v2, React 19 + TanStack + shadcn frontend.

**Spec:** `docs/superpowers/specs/2026-08-28-cross-session-comms-design.md`

## Plan-level amendments to the spec (decisions made while planning; rationale in parentheses)

1. **One apiKey plugin config, not two.** Keys are distinguished by `metadata.kind` (`"system" | "session"`). (The multi-`configId` plugin surface is underdocumented; one config removes a class of runtime surprises while preserving every behavior we need.)
2. **`sessions.api_key_id` column** stores the plugin key id for deterministic revoke/extend. (metadata-based lookup is LIKE-query territory; a column is indexed and typed.)
3. **Recipients get their own table** `channel_post_recipients(post_id, principal_id)` instead of a JSON column. (Portable SQL join instead of SQLite `json_each` — honors the "keep Kysely portable" decision.)
4. **The server never parses the JWE envelope** — it validates shape/size and trusts the client-supplied `recipientIds` list (which the read-filter joins on). (The recipient list is plaintext metadata by design; parsing base64 protected headers server-side adds code and leaks nothing more.)
5. **Nudge = literal text only, no Enter.** `send-keys -l "[mote] new post in #name"` so nothing can be accidentally submitted in a TUI.
6. **Nudge targets only session-principal members** that are currently running.
7. **`extend-token` strategy:** verify at spike time whether `updateApiKey` can push `expiresAt` out; if yes, session keys expire in 7 d and extend resets; if no, session keys are created non-expiring (revoke-on-lifecycle already bounds them) and `POST /:id/extend-token` returns `{ extended: false }` (200). Both paths are written out in Task 7.
8. **v1 wires MCP injection for `claude-code` only** (`--mcp-config`). Other harnesses receive the env vars but no MCP registration until each plugin's MCP story is confirmed; this is noted in docs, not hidden.

## Global Constraints

- Package manager: **Bun only** (`bun add`, `bunx`); versions pinned — after `bun add` run `bun syncpack fix`… exactly: `bunx syncpack fix-mismatches` is NOT used — use the repo flow: `bun add <pkg>` then `bunx syncpack@latest fix && bun install` per `.claude/rules/dependencies.md`.
- **No dynamic imports** anywhere (`await import(...)` forbidden — breaks `bun build --compile`).
- New tables: migration file **and** registration in `apps/backend/src/db/migrate.ts` static map **and** a `db-types` file added to `src/db/types/index.ts` `Database`.
- All Elysia `t` schema properties need `description`. Schemas as named constants, JSDoc on public functions.
- Tests co-located in `__tests__/`; backend tests use `setupAuthTables()` from `apps/backend/src/api/__tests__/helpers/auth-tables.ts`; tests run with `bun test src` in `apps/backend` (shared in-memory DB — never touch a real file DB).
- Verification after every task: `bun run verify-types && bun run lint:check && bun run test` (repo root; `lint` to fix first if needed). `turbo build` after backend route/schema changes (Eden types).
- Commit style: conventional commits (`feat(...)`, `chore(...)`, `docs(...)`), one commit per task minimum.
- Commits/pushes: commit locally per task (user pre-authorized implementation). Do NOT push.

---

### Task 1: Dependency install + library-API spike

**Files:**
- Modify: `apps/backend/package.json` (deps via bun add + syncpack)
- Create: `docs/superpowers/plans/artifacts/2026-08-28-cross-session-spike.md` (spike findings — commit alongside)

**Interfaces:**
- Produces: verified API shapes for `@better-auth/api-key`, `jose` General JWE, `@modelcontextprotocol/server` (recorded in the spike doc; later tasks assume the recorded shapes, and fix-forward if a mismatch appears).

- [ ] **Step 1: Install**

```bash
cd apps/backend
bun add jose @better-auth/api-key @modelcontextprotocol/server
bun add -d @modelcontextprotocol/client
bun add better-auth@1.7.2   # align patch if needed; MUST match @better-auth/api-key minor
bunx syncpack fix && bun install
```
Expected: lockfile updated, no `^`/`~` in package.json.

- [ ] **Step 2: MCP SDK v2 export spike**

```bash
cd apps/backend && bun -e '
const m = await import("@modelcontextprotocol/server");
const s = await import("@modelcontextprotocol/server/stdio");
const c = await import("@modelcontextprotocol/client");
const st = await import("@modelcontextprotocol/client/stdio");
console.log("server:", Object.keys(m)); console.log("stdio:", Object.keys(s));
console.log("client:", Object.keys(c)); console.log("client/stdio:", Object.keys(st));
'
```
Record exact export names (expected: `McpServer`, `StdioServerTransport`, `Client`, `StdioClientTransport`). NOTE: `-e` uses dynamic import for the *spike only* — this never lands in `src/`.

- [ ] **Step 3: jose sealed-delivery round-trip spike**

```bash
cd apps/backend && bun -e '
import("jose").then(async (jose) => {
  const { GeneralEncrypt, importJWK, exportJWK, generateKeyPair, flattenedDecrypt } = jose;
  const mk = async () => { const kp = await generateKeyPair("ECDH", { crv: "P-256", extractable: true }); return { pub: await exportJWK(kp.publicKey), priv: await exportJWK(kp.privateKey) }; };
  const a = await mk(), b = await mk();
  const ge = new GeneralEncrypt(new TextEncoder().encode("hello"));
  ge.setProtectedHeader({ enc: "A256GCM" });
  ge.addRecipient(await importJWK(a.pub, "ECDH"), { alg: "ECDH-ES+A256KW", kid: "p-a" });
  ge.addRecipient(await importJWK(b.pub, "ECDH"), { alg: "ECDH-ES+A256KW", kid: "p-b" });
  const env = JSON.parse(await ge.encrypt(undefined));
  console.log("recipient headers:", env.recipients.map((r) => r.header));
  const mine = env.recipients.find((r) => r.header?.kid === "p-b");
  const flat = await flattenedDecrypt({ ciphertext: env.ciphertext, iv: env.iv, tag: env.tag, protected: env.protected, recipients: [mine] }, await importJWK(b.priv, "ECDH"));
  console.log("decrypted:", new TextDecoder().decode(flat.plaintext));
});'
```
Expected: recipient headers visible with `kid`, decrypted: `hello`. If `addRecipient` rejects the header placement, record the working variant (recipient protected vs unprotected header) — the crypto module in Task 8 follows whatever the spike proves.

- [ ] **Step 4: apiKey plugin endpoint shapes spike**

Write a throwaway script `apps/backend/src/__spike.ts` (delete after), run with `bun src/__spike.ts`:

```ts
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { bunSqlite } from "kysely-bun-sqlite-dialect"; // match src/auth/database.js import
// (copy the authDatabase() construction from src/auth/database.js)
const auth = betterAuth({
  baseURL: "http://localhost:3080",
  secret: "spike-secret-0123456789-0123456789-abcdef",
  database: authDatabase(),
  emailAndPassword: { enabled: true },
  plugins: [apiKey({ enableMetadata: true, defaultPrefix: "mote_", requireName: true,
    customAPIKeyGetter: (ctx: any) => (ctx.headers?.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || null })],
});
await auth.api.createUser?.({ body: { name: "spike", email: "s@x.local", password: "spike-pass-123" } })
  ?? console.log("no createUser; insert user via SQL instead");
const created = await auth.api.createApiKey({ body: { name: "k1", userId: "<id>",
  expiresIn: 3600, metadata: JSON.stringify({ kind: "session", sessionId: "sid-1" }),
  permissions: { channels: ["read", "write"], sessions: ["read", "write"] } } } as any);
console.log("create:", Object.keys(created));
const v = await auth.api.verifyApiKey({ body: { key: (created as any).key } });
console.log("verify:", JSON.stringify(v, null, 2));
const u = await auth.api.updateApiKey({ body: { keyId: (created as any).id, enabled: false } } as any);
console.log("update:", JSON.stringify(u)?.slice(0, 200));
const u2 = await auth.api.updateApiKey({ body: { keyId: (created as any).id, expiresIn: 3600 } } as any);
console.log("update expiry result:", JSON.stringify(u2)?.slice(0, 200)); // decides amendment #7 branch
```

Record in the spike doc: (a) does `verifyApiKey` return the key row (under what property — `apiKey`?) incl. `metadata`/`permissions`/`userId`; (b) does `createApiKey` accept `expiresIn`/`metadata`/`permissions` server-side without headers; (c) can `updateApiKey` extend `expiresAt`; (d) actual apikey table name + columns (`PRAGMA table_info(apikey)` via `bun:sqlite`) for the SQL fallbacks. **If a capability is missing, use the SQL fallback written into Tasks 4/5/7 — decide by evidence, record the choice.**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(deps): add jose, mcp sdk v2, better-auth api-key plugin"
```

---

### Task 2: Migration 0009 + db types

**Files:**
- Create: `apps/backend/src/db/migrations/0009-channels.ts`
- Modify: `apps/backend/src/db/migrate.ts` (import + map entry `"0009-channels"`)
- Create: `apps/backend/src/db/types/channels.db-types.ts`, `identities.db-types.ts`, `channel-posts.db-types.ts`
- Modify: `apps/backend/src/db/types/index.ts`, `apps/backend/src/db/types/sessions.db-types.ts` (add `apiKeyId: string | null;`)
- Test: `apps/backend/src/db/migrations/__tests__/channels-migration.test.ts`

**Interfaces:**
- Produces tables (SQL snake_case → Kysely camelCase via `CamelCasePlugin`):
  - `channels(id, name UNIQUE, created_by, created_at)`, `channel_members(channel_id, principal_id, added_at, added_by)`, `channel_posts(id, channel_id, seq, author, envelope, created_at)`, `channel_post_recipients(post_id, principal_id)`, `channel_cursors(channel_id, principal_id, last_seq)`, `identities(principal_id, public_key, display_name, registered_at)`, `sessions.api_key_id`
- Produces TS: `ChannelTable {id,name,createdBy,createdAt}`, `NewChannel {id,name,createdBy}`, `IdentityTable {principalId,publicKey,displayName,registeredAt}`, `ChannelMemberTable {channelId,principalId,addedAt,addedBy}`, `ChannelPostTable {id,channelId,seq,author,envelope,createdAt}`, `ChannelCursorTable {channelId,principalId,lastSeq}`; `Database` gains `channels`, `channelMembers`, `channelPosts`, `channelPostRecipients`, `channelCursors`, `identities`; `SessionTable` gains `apiKeyId`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/db/migrations/__tests__/channels-migration.test.ts
import { beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";

/** The channels feature tables exist with the expected columns after migrations. */
describe("0009-channels migration", () => {
  beforeAll(async () => { await runMigrations(); });

  for (const t of ["channels", "channel_members", "channel_posts", "channel_post_recipients", "channel_cursors", "identities"]) {
    it(`table ${t} exists`, async () => {
      const r = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' AND name=${t}`.execute(db);
      expect(r.rows.length).toBe(1);
    });
  }
  it("sessions gains api_key_id", async () => {
    const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info('sessions')`.execute(db);
    expect(r.rows.map((x) => x.name)).toContain("api_key_id");
  });
  it("channel posts unique (channel_id, seq)", async () => {
    await db.insertInto("channels").values({ id: "c1", name: "smoke", createdBy: "user:t" }).execute();
    await db.insertInto("channelPosts").values({ id: "p1", channelId: "c1", seq: 1, author: "user:t", envelope: "{}" }).execute();
    // @ts-expect-error duplicate must violate the unique index
    await expect(db.insertInto("channelPosts").values({ id: "p2", channelId: "c1", seq: 1, author: "user:t", envelope: "{}" }).execute()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/backend && bun test src/db/migrations/__tests__/channels-migration.test.ts` (no such file/table).
- [ ] **Step 3: Write the migration**

```ts
// apps/backend/src/db/migrations/0009-channels.ts
import { type Kysely, sql } from "kysely";

/**
 * Cross-session channels: an append-only encrypted post log with per-channel
 * sequences, membership as public-key registration (sealed delivery),
 * per-principal read cursors, and the session->api-key link used to revoke
 * a session's token when the session dies.
 *
 * `envelope` is a jose General JWE JSON string; the server never parses it.
 * The recipient list is denormalized into channel_post_recipients so reads
 * can filter (portably, via join) to posts the caller can decrypt.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createTable("channels")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("name", "text", (c) => c.notNull().unique())
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema.createTable("identities")
    .addColumn("principal_id", "text", (c) => c.primaryKey())
    .addColumn("public_key", "text", (c) => c.notNull())
    .addColumn("display_name", "text")
    .addColumn("registered_at", "text", (c) => c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();

  await db.schema.createTable("channel_members")
    .addColumn("channel_id", "text", (c) => c.notNull().references("channels.id", (r) => r.onDelete("cascade")))
    .addColumn("principal_id", "text", (c) => c.notNull())
    .addColumn("added_at", "text", (c) => c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .addColumn("added_by", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("idx_channel_members_pk").on("channel_members").columns(["channel_id", "principal_id"]).unique().execute();

  await db.schema.createTable("channel_posts")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("channel_id", "text", (c) => c.notNull().references("channels.id", (r) => r.onDelete("cascade")))
    .addColumn("seq", "integer", (c) => c.notNull())
    .addColumn("author", "text", (c) => c.notNull())
    .addColumn("envelope", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`))
    .execute();
  await db.schema.createIndex("idx_channel_posts_cursor").on("channel_posts").columns(["channel_id", "seq"]).unique().execute();

  await db.schema.createTable("channel_post_recipients")
    .addColumn("post_id", "text", (c) => c.notNull().references("channel_posts.id", (r) => r.onDelete("cascade")))
    .addColumn("principal_id", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("idx_cpr_lookup").on("channel_post_recipients").columns(["principal_id", "post_id"]).execute();

  await db.schema.createTable("channel_cursors")
    .addColumn("channel_id", "text", (c) => c.notNull().references("channels.id", (r) => r.onDelete("cascade")))
    .addColumn("principal_id", "text", (c) => c.notNull())
    .addColumn("last_seq", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema.createIndex("idx_cursors_pk").on("channel_cursors").columns(["channel_id", "principal_id"]).unique().execute();

  await db.schema.alterTable("sessions").addColumn("api_key_id", "text").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of ["channel_cursors", "channel_post_recipients", "channel_posts", "channel_members", "identities", "channels"]) {
    await db.schema.dropTable(t).execute();
  }
  await db.schema.alterTable("sessions").dropColumn("api_key_id").execute();
}
```

Register in `migrate.ts`: `import * as channelsMigration from "@/db/migrations/0009-channels.js";` + map entry `"0009-channels": channelsMigration,`.

- [ ] **Step 4:** db-types files (mirror `bookmarks.db-types.ts` shape: table interface with per-property JSDoc, `New*`, `*Update = Partial<New*>` where useful) + add to `Database` in `types/index.ts` + add `apiKeyId: string | null` to `SessionTable` (and its `SessionUpdate`).
- [ ] **Step 5: Run test → PASS. Verify + lint. Commit** `feat(db): channels tables + session api-key link`

---

### Task 3: Repositories + post event bus

**Files:**
- Create: `apps/backend/src/db/repositories/channels.repository.ts`, `identities.repository.ts`, `channel-posts.repository.ts`
- Create: `apps/backend/src/services/channels/post-bus.ts`
- Test: `apps/backend/src/db/repositories/__tests__/channels.repository.test.ts`, `.../identities.repository.test.ts`, `.../channel-posts.repository.test.ts`; `apps/backend/src/services/channels/__tests__/post-bus.test.ts`

**Interfaces (Produces — Tasks 6/7 import these exact names):**
- `ChannelsRepository` (extends `BaseRepository`): `create(name, createdBy): Promise<ChannelTable>` (throws `ChannelNameTakenError`), `findByName(name)`, `findById(id)`, `listWithCounts(): Promise<(ChannelTable & { memberCount: number; lastSeq: number })[]>`, `addMember(channelId, principalId, addedBy)` (idempotent), `members(channelId): Promise<ChannelMemberTable[]>`, `removeForChannel/cascade handled by FK`.
- `IdentitiesRepository`: `register(principalId, publicJwkJson, displayName | null): Promise<IdentityTable>` (upsert = rotate), `findByPrincipal(principalId)`.
- `ChannelPostsRepository`: `append({ channelId, author, envelope, recipientIds }): Promise<{ seq: number; id: string }>` (tx: MAX+1 + insert + recipients), `listVisible(channelId, principalId, since, limit): Promise<ChannelPostTable[]>` (join recipients, seq>since asc), `maxSeq(channelId)`, `getCursor(channelId, principalId): Promise<number>`, `setCursor(channelId, principalId, seq)`.
- `post-bus.ts`: `notifyPosts(channelId: string): void`, `subscribe(channelId: string, cb: () => void): () => void`.

- [ ] **Step 1:** failing tests (repo: create/list/409-by-error/idempotent join/append-seq-monotonic/visibility-filter/cursor set-get; bus: subscriber receives notify, unsubscribe works).
- [ ] **Step 2:** run, fail.
- [ ] **Step 3: Implement.** Repositories follow `bookmarks.repository.ts` idiom (class extends `BaseRepository`, `this.db`). `append` in a transaction:

```ts
async append({ channelId, author, envelope, recipientIds }: AppendInput): Promise<{ seq: number; id: string }> {
  return this.db.transaction().execute(async (tx) => {
    const agg = await tx.selectFrom("channelPosts").select((eb) => eb.fn.max<number, string>("seq").as("maxSeq")).where("channelId", "=", channelId).executeTakeFirstOrThrow();
    const seq = (agg.maxSeq ?? 0) + 1;
    const id = crypto.randomUUID();
    await tx.insertInto("channelPosts").values({ id, channelId, seq, author, envelope }).execute();
    await tx.insertInto("channelPostRecipients").values(recipientIds.map((principalId) => ({ postId: id, principalId }))).execute();
    return { seq, id };
  });
}
```
(`listVisible` joins `channelPostRecipients` on `channelPosts.id` filtered by `principalId`.) `post-bus.ts` is a module-level `new EventEmitter()` with `setMaxListeners(0)`.
- [ ] **Step 4:** tests PASS → verify trio → commit `feat(db): channel repositories + post event bus`

---

### Task 4: apiKey plugin + system user + session-token service

**Files:**
- Modify: `apps/backend/src/auth.ts` (add `plugins: [apiKey({...})]`)
- Create: `apps/backend/src/services/session-tokens.ts`, `apps/backend/src/auth/system-user.ts`
- Modify: `apps/backend/src/index.ts` (after `runAuthMigrations()`: `await ensureSystemUser()`)
- Test: `apps/backend/src/services/__tests__/session-tokens.test.ts`

**Interfaces:**
- Consumes: `sessions.api_key_id` (Task 2), `SessionsRepository`.
- Produces:
  - `const SYSTEM_USER_EMAIL = "system@mote.local"`; `ensureSystemUser(): Promise<string>` (insert-if-missing via raw SQL into better-auth `user` table with a random 64-char password hash via `better-auth/crypto.hashPassword`; returns id).
  - `issueSessionToken(sessionId: string, userId: string): Promise<string /* plaintext key */>` — `auth.api.createApiKey` `{ name: "sess:<id>", userId, metadata: JSON.stringify({kind:"session",sessionId}), permissions: { channels: ["read","write"], sessions: ["read","write"] } }` (+`expiresIn` only if spike proved extension works); stores `apiKeyId` on the session row.
  - `extendSessionToken(sessionId): Promise<boolean>`, `revokeSessionToken(sessionId): Promise<void>` (via `updateApiKey {enabled:false}` or the spike-chosen SQL fallback; also works when already revoked).
  - `SYSTEM_KEY_PERMISSIONS = undefined` meaning unrestricted.

- [ ] **Step 1:** failing test: issue → `verifyApiKey` returns valid and exposes metadata/permissions per spike-recorded shape; revoke → invalid; extend semantics assert the branch the spike chose.
```ts
// apps/backend/src/services/__tests__/session-tokens.test.ts
import { beforeAll, describe, expect, it } from "bun:test";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { ensureSystemUser, extendSessionToken, issueSessionToken, revokeSessionToken } from "@/services/session-tokens.js";
import { setupAuthTables, deleteUserByEmailOrId } from "@/api/__tests__/helpers/auth-tables.js";

describe("session tokens", () => {
  let userId: string;
  beforeAll(async () => { await setupAuthTables(); userId = await ensureSystemUser(); });
  /** Inserts a bare session row (no tmux) — tokens care about the row, not the process. */
  async function fakeSession(): Promise<string> {
    const id = crypto.randomUUID();
    await new SessionsRepository(db).create({ id, userId, profileId: "p", harnessId: "claude-code", name: "t", workingDir: "/tmp", tmuxSocket: "s" } as never);
    return id;
  }
  it("issues a verifiable token bound to the session", async () => {
    const sid = await fakeSession();
    const key = await issueSessionToken(sid, userId);
    const res = await auth.api.verifyApiKey({ body: { key } });
    expect((res as any).valid).toBe(true);
    const meta = JSON.parse((res as any).apiKey.metadata);   // shape per spike
    expect(meta).toEqual({ kind: "session", sessionId: sid });
    await revokeSessionToken(sid);
    expect((await auth.api.verifyApiKey({ body: { key } }) as any).valid).toBe(false);
  });
});
```
(Adjust the fake-session values to `NewSession`'s actual required fields when writing.)
- [ ] **Step 2:** fail.
- [ ] **Step 3:** Implement. auth.ts plugin block (exact config decided from spike; base form):
```ts
import { apiKey } from "@better-auth/api-key";
// inside betterAuth({...}):
  plugins: [
    apiKey({
      enableMetadata: true,
      requireName: true,
      defaultPrefix: "mote_",
      // Bearer header, not x-api-key (spec §8).
      customAPIKeyGetter: (ctx) => (ctx.headers?.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || null,
    }),
  ],
```
`system-user.ts` inserts via `sql`insert into "user" (id, name, email, emailVerified, image, createdAt, updatedAt) values (...)` with `emailVerified: 0` and a random hashed password (unusable login by design — no UI password known). `session-tokens.ts` per interfaces above; every better-auth call wrapped so failures log via `logger` and throw `SessionTokenError` (500-mapped).
- [ ] **Step 4:** PASS → verify trio → commit `feat(auth): api-key plugin, system user, session token lifecycle`

---

### Task 5: authGuard bearer branch + permissions + principal

**Files:**
- Modify: `apps/backend/src/api/auth-guard.ts`
- Test: `apps/backend/src/api/__tests__/auth-guard-bearer.test.ts`

**Interfaces:**
- Produces (used by ALL later route work): derive injects, alongside existing `user`/`session`, additionally: `principal: string` (`"user:<id>"` for cookie + system keys, `"sess:<id>"` for session tokens), `actor: "cookie" | "system-key" | "session-key"`, `apiKeyId: string | null`, `apiKeyPermissions: Record<string, string[]> | null` (null = cookie/system = unrestricted).
- Produces: `export function requirePerm(ctx: { actor: string; apiKeyPermissions: Record<string, string[]> | null }, resource: "channels" | "sessions", action: "read" | "write"): void` — throws `ForbiddenError` (403) when a session key lacks the action.
- `requireAdmin`: adds `if (actor !== "cookie") throw new ForbiddenError();` (admin ops need interactive login — plan amendment).

**Behavior:** cookie path first (unchanged, plus `principal`/`actor`/…defaults). No cookie AND `Authorization: Bearer` present → `auth.api.verifyApiKey({ body: { key } })`; invalid/expired/revoked → 401 `UnauthorizedError`. Metadata `kind==="session"` → load session row via `SessionsRepository.findById(meta.sessionId)`; missing row → 401; else `user = { id: row.userId } as User` (routes use `user.id` only), `principal = sess:<id>`. Otherwise (system key, or key owned by the system user) → `user = { id: keyOwnerUserId }`, `principal = user:<id>`, `actor = "system-key"`.

- [ ] **Step 1:** failing tests, mounting a tiny probe app:
```ts
const probe = new Elysia().use(authGuard).get("/probe", (c) => ({ principal: c.principal, actor: c.actor, perms: c.apiKeyPermissions, userId: c.user.id }));
```
Cases: cookie regression (user id, actor cookie, principal `user:`); system-key bearer (200, actor system-key, perms null); session-key bearer on a fake session row (actor session-key, principal `sess:<id>`, userId == session owner); revoked → 401; garbage → 401; `requirePerm({actor:"session-key",apiKeyPermissions:{channels:["read"]}},"channels","write")` throws, `"read"` passes; cookie actor always passes.
- [ ] **Step 2:** fail. **Step 3:** implement (single verifyApiKey per request — the rate-limit double-count trap). **Step 4:** PASS; run existing `users-admin`/`bookmarks-route` suites (cookie regression gate) → verify trio → commit `feat(api): bearer api-key auth path in authGuard`

---

### Task 6: Channels + identities REST routes (incl. long-poll + nudge)

**Files:**
- Create: `apps/backend/src/api/channels.route.ts`, `apps/backend/src/api/identities.route.ts`, `apps/backend/src/services/channels/read-wait.ts`
- Modify: `apps/backend/src/api/routes.ts` (`.use(channelRoutes).use(identityRoutes)`)
- Test: `apps/backend/src/api/__tests__/channels-route.test.ts`, `identities-route.test.ts`, `apps/backend/src/services/channels/__tests__/read-wait.test.ts`

**Interfaces (Consumes: Task 3 repos, Task 5 guard. Produces for Task 9 MCP client — exact JSON shapes):**
- `POST /api/identities` `{ publicKey: string, displayName?: string }` → 200 `{ principalId, publicKey, registeredAt }` (self only; principal from guard).
- `GET /api/identities/:principalId` → 200 identity or 404.
- `POST /api/channels` `{ name }` → 200 `{ id, name }`; 409 name taken. Slug schema: `t.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: ... })`.
- `GET /api/channels` → `{ channels: [{ id, name, createdBy, createdAt, memberCount, lastSeq }] }`.
- `POST /api/channels/:name/members` → 200 `{ joined: true }` (idempotent; auto-register caller's identity row? No — 409 `identity_required` if caller has no identity).
- `GET /api/channels/:name/members` → `{ members: [{ principalId, publicKey, addedAt }] }` (join identities; members with no identity row get `publicKey: null`).
- `POST /api/channels/:name/posts` `{ envelope: t.String({ maxLength: 131072, ... }), recipientIds: t.Array(t.String({minLength:1,maxLength:120}), { minItems: 1, maxItems: 256, ... }), nudge?: boolean }` → `{ seq, id }`. Validation: all recipientIds must be current members (400 otherwise). `nudge` → after append, for each recipient `sess:` id with a running session (alive=1, tmuxSocket set): `tmux.sendInput(socket, id, \`[mote] new post in #${name}\`)` (best-effort try/catch per session).
- `GET /api/channels/:name/posts?since&wait&limit&mark` → 200 `{ posts: [{ id, seq, author, envelope, createdAt }], nextSince }`. Defaults: `since` = caller cursor (or 0 if absent) when `mark` param sent as `1`; explicit `since` wins; limit default 100 (max 500); `wait` seconds clamped `[0,600]`. Long-poll semantics: return immediately if rows exist; else await bus events until rows or deadline; deadline → 200 empty; client abort (request.signal) → stop writing. When `mark=1`, cursor := max seq returned (or unchanged on empty).
- `GET /api/channels/:name/cursor` → `{ lastSeq, unread: number }`.

`read-wait.ts`: `export async function waitForNewPosts(channelId: string, hasNew: () => Promise<boolean>, waitMs: number, signal: AbortSignal): Promise<void>` — checks `hasNew`, subscribes via post-bus, polls-notify-races with `setTimeout` deadline + heartbeat-friendly resolution. All routes `.use(authGuard)` + `requirePerm` calls; `channels` for reads, `channels:write` for posts/joins/creates; identity routes need `channels` read permission minimum.

- [ ] **Step 1:** failing tests using cookie sessions (`authedRequest`) + one bearer session key (created via `issueSessionToken` + `fakeSession` helper, exported from a new `helpers/tokens.ts` for reuse): create/409/join/identity-required/append+visible-only-to-recipient (post to A+B members, read as A → present; as C (member joined later) → absent)/cursor+mark/long-poll empty-at-small-wait (wait=1, no posts, assert ~1s ≥ status 200 `[]`)/recipient-not-member 400/size cap 400 via Elysia's limit + explicit check/nudge test with `TmuxRunner` injectable seam — routes construct the manager through a module-level factory you stub via a setter exported for tests, `setTmuxForTests()` `@internal`.
- [ ] **Step 2:** fail. **Step 3:** implement (named `t` schema constants with descriptions; response schemas too). SSE-style stream for waits is NOT used — plain JSON after wait (simpler + Eden-friendly). **Step 4:** PASS → verify trio + `turbo build` → commit `feat(api): encrypted channels REST with recipient-filtered long-poll reads`

---

### Task 7: Session-manager integration (tokens, env, prompt, extend route, revoke hooks)

**Files:**
- Modify: `apps/backend/src/services/session-manager.service.ts` (createSession: `prompt?` param + token issue + `MOTE_*` env; `#deliverPrompt`; terminate/delete: revoke; maybeAutoRestart: extend; reconcileRows crash branch: revoke when `restartOnExit !== 1`, extend otherwise)
- Modify: `apps/backend/src/services/tmux/tmux-runner.ts` (add `pressEnter(socket, sessionName)` → `["-L",s,"send-keys","-t",n,"Enter"]`)
- Modify: `apps/backend/src/api/sessions.route.ts` (body `prompt` optional; response gains `promptDelivered: boolean`; new `POST /:id/extend-token` guarded so cookie-owner OR the session's own bearer key may call)
- Test: extend `apps/backend/src/services/__tests__/` session-manager suites + `apps/backend/src/api/__tests__/sessions-prompt-route.test.ts`

**Interfaces:**
- `createSession({ userId, profileId, workingDir, name?, prompt? }): Promise<{ id, tmuxSocket, apiKey, promptDelivered }>` — `apiKey` plaintext returned once and included in the route response ONLY when the caller is a bearer session key? No: never echo keys in responses; the created session's `mote mcp` gets it via env. Response adds `promptDelivered: boolean` only. (Route response schema gains `promptDelivered`.)
- `buildHarnessCommand(harness, binary, cwd, profile, sessionName, moteEnv)` — `moteEnv: { MOTE_API_KEY, MOTE_BASE_URL, MOTE_SESSION_ID }` merged into env alongside curated env.
- `#deliverPrompt(socket, id, prompt)`: poll `capturePane` (stripAnsi trim non-blank) every 500 ms ≤ 15 s; then `sendInput(prompt)`; then `pressEnter`. False if never settles.

**Key detail:** `createSession` currently returns `{id, tmuxSocket}` — update ALL call sites (restart, live route tests). Keep token issuance AFTER tmux spawn success and BEFORE audit (and mark terminated + revoke if a later step throws).

- [ ] **Step 1:** failing tests with mocked `TmuxRunner` subclass: (a) create issues a token verifiable via `verifyApiKey` and stores `apiKeyId`; (b) env string contains `MOTE_API_KEY='mote_` and `MOTE_SESSION_ID='<id>` (capture the `cmd` passed to `newSession`); (c) prompt: mock `capturePane` blank→non-blank: assert `sendInput` called with prompt, `pressEnter` called, `promptDelivered` true; never-settles (shortened timeout via injected `settleTimeoutMs` opt, default 15000): false, no send; (d) terminate revokes (verify invalid); (e) `restartSession` issues a fresh token for the new row; (f) extend route: owner-cookie 200; a DIFFERENT session's bearer key 403; own bearer key 200.
- [ ] **Step 2:** fail. **Step 3:** implement, honoring amendment #7's spike-chosen branch for extend semantics. `buildHarnessCommand` signature change flows through `maybeAutoRestart` too. **Step 4:** PASS (whole session-manager suite!) → verify trio → commit `feat(sessions): per-session tokens, MOTE env injection, prompt-on-create, extend-token route`

---

### Task 8: `mote mcp` crypto module

**Files:**
- Create: `apps/backend/src/mcp/crypto.ts`, `apps/backend/src/mcp/identity-store.ts`
- Test: `apps/backend/src/mcp/__tests__/crypto.test.ts`, `identity-store.test.ts`

**Interfaces (Consumes Task 1 spike findings. Produces for Task 9):**
- `type IdentityKeyPair = { principalId: string; publicJwk: string; privateJwk: string }` (JWKs stored as JSON strings).
- `generateKeypair(): Promise<{ publicJwk: string; privateJwk: string }>` (P-256 ECDH, extractable).
- `seal(text: string, recipients: { principalId: string; publicJwk: string }[]): Promise<{ envelope: string; recipientIds: string[] }>` — GeneralEncrypt per the spike (shared protected `{enc:"A256GCM"}`, per-recipient `ECDH-ES+A256KW` + kid in the spike-verified header position).
- `open(envelope: string, own: IdentityKeyPair): Promise<string>` — parse General JSON, locate the recipient entry whose kid === own.principalId (unprotected OR protected-decoded — check both), rebuild flattened, `flattenedDecrypt`; throws `DecryptError` if absent/unparseable.
- `identity-store.ts`: `loadOrCreateIdentity(dataDir: string, principalId: string): Promise<IdentityKeyPair>` — file `<dataDir>/identities/<principal-file-safe-id>.json` (mode 0600, mkdir -p), returns stored pair (principalId stamped/checked; a file for a different principal is an error, not an overwrite).

- [ ] **Step 1:** tests: seal→open roundtrip for 2 recipients (each opens own); non-recipient (`DecryptError`); tampered ciphertext fails; unicode/empty-string text; store roundtrip persists + reloads identical; 0600 mode. **Step 2:** fail. **Step 3:** implement (`import { GeneralEncrypt, flattenedDecrypt, generateKeyPair, exportJWK, importJWK, decodeProtectedHeader } from "jose";` — static imports only). **Step 4:** PASS → commit `feat(mcp): sealed-delivery crypto + identity store`

---

### Task 9: `mote mcp` REST client, tools, CLI entry

**Files:**
- Create: `apps/backend/src/mcp/api-client.ts`, `apps/backend/src/mcp/tools-channels.ts`, `apps/backend/src/mcp/tools-sessions.ts`, `apps/backend/src/mcp/index.ts`
- Modify: `apps/backend/src/index.ts` (argv dispatch: `if (process.argv[2] === "mcp") { void runMoteMcp(); } else { startServer(...) }` — read the current file first; keep server path untouched)
- Test: `apps/backend/src/mcp/__tests__/api-client.test.ts`, `tools.test.ts`

**Interfaces:**
- `class MoteApi` — `constructor({ baseUrl, apiKey })`; `req<T>(path, init?)` sets `Authorization: Bearer`, JSON in/out, throws `ApiError { status, message }`; `extendOwnToken()` → `POST /api/sessions/<selfId>/extend-token`.
- `McpDeps` type threading `{ api: MoteApi, own: IdentityKeyPair, fetchMembers, ... }` so tool handlers are pure and testable without stdio.
- `registerChannelTools(server, deps)` / `registerSessionTools(server, deps)` using `server.registerTool(name, { title, description, inputSchema: <zod> }, handler)` (exact v2 signature per spike; zod is a dep of the MCP server pkg — `bun add zod` if not resolvable directly).
- `runMoteMcp(): Promise<void>` — env: `MOTE_API_KEY` (required), `MOTE_BASE_URL` (default `http://127.0.0.1:3080`), `MOTE_SESSION_ID` (required), `MOTE_DATA_DIR` (default `SESSION_DATA_DIR`); bootstrap identity (load-or-create principal `sess:<id>`, `POST /api/identities`); 12 h `setInterval` extend (`.unref()` NOT used — we want it alive; but call once per tick, errors logged); `McpServer` + `StdioServerTransport`; tools:
  - **Amendment (as-built):** the extend timer IS `.unref()`d — the stdio connection (stdin open) is what keeps the process alive, and an unref'd timer does not block exit when the client disconnects; leaving it ref'd would wedge the child after transport close. Code at `apps/backend/src/mcp/server.ts:233` is authoritative.

| Tool | Behavior |
|---|---|
| `mote_list_channels {}` | GET /api/channels |
| `mote_create_channel {name}` | POST |
| `mote_join_channel {name}` | POST members |
| `mote_read_channel {name, since?, wait_seconds?, limit?}` | GET posts (chunk waits to 50 s slices, loop until budget exhausted or posts arrive — honors `ctx.mcpReq.signal` abort); `open()` each envelope (skip+count failures, report `undecryptable` count); advance cursor via `mark=1` |
| `mote_post_channel {name, text, nudge?}` | members → filter `publicKey != null` → `seal` → POST; joins channel first if not a member |
| `mote_channel_members {name}` | GET members (strip keys) |
| `mote_list_sessions {}` / `mote_get_session {id}` / `mote_list_profiles {}` | GET /api/sessions etc. |
| `mote_create_session {name?, profile, working_dir, prompt?}` | resolve profile by NAME via GET /api/profiles → id; POST /api/sessions; returns `{ id, promptDelivered }` |
| `mote_restart_session {id}` / `mote_terminate_session {id}` / `mote_delete_session {id}` / `mote_update_session_notes {id, notes}` | the matching REST calls |

- [ ] **Step 1:** tests: `MoteApi` against stubbed `globalThis.fetch` (bearer header, non-JSON error body mapping, 401 `ApiError`); tool handlers called directly with `MoteDeps` backed by a fake api (fake envelopes from `seal()` with the fake own key — real crypto in unit tests, no HTTP): read decrypts posted content end-to-end in-process; create_session profile-name resolution error path.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** PASS → verify trio → `bun run compile` in apps/backend once (catches compile-pipeline breakage early) → commit `feat(mcp): mote mcp stdio server with channel + session tools`

---

### Task 10: Harness MCP injection (claude-code)

**Files:**
- Modify: `packages/harnesses/src/types.ts` (`BuildCommandInput` gains `mcpConfigPath?: string` + JSDoc)
- Modify: `packages/harnesses/src/claude-code.ts` (`buildCommand`: when `input.mcpConfigPath`, push `"--mcp-config", input.mcpConfigPath`)
- Modify: `apps/backend/src/services/session-manager.service.ts` — before building the command: write `<SESSION_DATA_DIR>/mcp/<id>.json` = `{"mcpServers":{"mote":{"command":<selfCmd[0]>,"args":[...selfCmd.slice(1),"mcp"]}}}` where selfCmd = `process.execPath` + (`process.argv[1]` when running from source, else nothing for compiled); pass `mcpConfigPath` into `buildHarnessCommand` → plugin input.
- Test: `packages/harnesses/src/__tests__/mcp-config.test.ts` (argv contains the flag when set, absent otherwise) + session-manager test asserting the generated JSON file shape.

Docs: add a note to each other plugin's header comment (`hermes.ts`, `opencode.ts`, `pi.ts`): "MCP registration for mote channels: not wired in v1 — env vars are injected; add when the harness's MCP config format is confirmed."

- [ ] Steps: test → fail → implement → pass → `turbo build` (harnesses is a `packages/` dep) → verify trio → commit `feat(harnesses): register mote mcp server with claude-code sessions`

---

### Task 11: Admin system-keys REST routes

**Files:**
- Create: `apps/backend/src/api/system-keys.route.ts` (+ `routes.ts` mount)
- Test: `apps/backend/src/api/__tests__/system-keys-route.test.ts`

**Interfaces:** `requireAdmin` (cookie-admin only). `GET /api/system-keys` → `{ keys: [{ id, name, preview, enabled, createdAt, expiresAt }] }` (plugin `listApiKeys` server-side, else the spike-recorded SQL select of the apikey table — NEVER return hashes). `POST { name }` → 201 `{ id, key }` (key once; owner = system user; metadata `{kind:"system"}`; no expiry if spike chose non-expiring else `expiresIn: null`). `PATCH /:id` `{ enabled }` → `{ ok: true }` (revoking the key you're using is impossible-by-construction since admin routes reject bearers). `DELETE /:id` → `{ ok: true }` (plugin delete or SQL fallback).

- [ ] Steps: tests (403 for plain user, 401 anonymous; create→listed with preview→disable→enable→delete; `key` shape `mote_` prefix) → fail → implement → pass → `turbo build` → verify trio → commit `feat(api): admin CRUD for system api keys`

---

### Task 12: Frontend — API-keys card on /settings

**Files:**
- Try: `apps/frontend` — `bunx shadcn@latest add @better-auth-ui/api-key` (bounded attempt, ≤15 min wall)
- Likely create (fallback, and this is the expected path): `apps/frontend/src/components/system-api-keys-card.tsx`, `apps/frontend/src/hooks/use-system-keys.ts`
- Modify: `apps/frontend/src/routes/settings.tsx` (render `<SystemApiKeysCard />` after the Registration card, inside the existing admin-only region)

**Decision rule:** if the registry copy lands and builds without pulling in a parallel auth-provider world, keep its components pointed at `/api/system-keys`; otherwise `git checkout -- apps/frontend` that attempt and ship the hand-rolled card below (same capability set: list/create/reveal-once-with-copy/disable/enable/delete; better-auth-ui is designed as copy-in code we own anyway — hand-rolled in the app's own shadcn idiom preserves that intent). Record which path ran in the commit message.

- [ ] **Step 1:** card component (complete code in fallback form):

```tsx
// use-system-keys.ts — TanStack Query hooks over apiFetch:
//   useSystemKeys() -> { data: { keys: SystemKeyRow[] } }
//   useCreateSystemKey() -> mutation -> { id, key }
//   useSetSystemKeyEnabled(), useDeleteSystemKey()
```
`SystemKeyRow = { id: string; name: string; preview: string | null; enabled: boolean; createdAt: string; expiresAt: string | null }`. Card: table of rows with Switch (enabled), delete Button (confirm via `window.confirm`-free inline confirm state), "Create key" dialog (name Input → success panel showing the plaintext ONCE with a copy button and a warning it won't be shown again). Errors surface via the existing pattern (inline text, not toasts — match harness card idiom).
- [ ] **Step 2:** `bun run verify-types && bun run lint:check && bun run test` at root; `turbo build` produces the SPA.
- [ ] **Step 3:** Commit `feat(ui): system api keys management card in settings`

---

### Task 13: Headline e2e — two `mote mcp` processes, ciphertext-only storage

**Files:**
- Create: `apps/backend/src/scripts/e2e-seed.ts` (standalone runner sharing a file DB: `DATABASE_PATH=<tmp> bun src/scripts/e2e-seed.ts create|token|ciphertext` — creates user+profile+session row(s), prints session tokens; `ciphertext` prints `envelope` + asserts no plaintext substring)
- Test: `apps/backend/src/__tests__/e2e-cross-session.test.ts`

**Flow (bun test, 120 s timeout):** temp dir `DATABASE_PATH`; spawn backend child (`bun src/index.ts`, env `PORT=0`→use fixed high port + `HOST=127.0.0.1`); wait for `/api/meta` 200 (poll ≤15 s); seed script as root user → two session tokens; spawn two `bun src/index.ts mcp` children with each token's env; connect via `@modelcontextprotocol/client` + `StdioClientTransport`; A: `mote_create_channel`, `mote_join_channel`; B: join; A: `mote_post_channel {name:"e2e", text:"hello-from-A"}`; B: `mote_read_channel {name:"e2e", wait_seconds: 20}` → expect one post, decrypted text exact, author `sess:<A-id>`; B posts back, A reads; then `e2e-seed.ts ciphertext` → envelope JSON present, `hello-from-A` NOT in the DB file bytes; assert `mote_list_sessions` visible to A (bearer session-CRUD path works over real HTTP).

- [ ] Steps: write test → run (expect discovery of wiring bugs — fix forward in the modules, NOT by weakening assertions) → full `bun test` green → commit `test(e2e): two sessions converse over encrypted channels via mote mcp`

---

### Task 14: Live browser verification (Chrome DevTools MCP)

Manual-gate replacement: drive a real browser against a real instance.

- [ ] **Step 1:** Build + boot prod-equivalent locally: `turbo build`, then start backend on port 3080 against a FRESH temp `DATABASE_PATH` (never the user's live DB for destructive checks). Register first user via the SPA (becomes admin) using chrome-devtools MCP (`navigate_page` → `take_snapshot` → `fill`/`click`).
- [ ] **Step 2:** Settings page: create system key `browser-e2e`; copy plaintext; toggle disable → re-enable; delete one. Screenshots at each state; console via `list_console_messages` must be error-free.
- [ ] **Step 3:** From the browser context (`evaluate_script`) fetch `/api/channels` with the key as Bearer via `fetch` from a page on the same origin after… — cookie interference makes browser-side key checks ambiguous; do the key-auth HTTP assertions with `curl` from Bash instead (200 with key, 401 after disable). Record outputs in the commit message/notes.
- [ ] **Step 4:** Regression pass in the browser: login, sessions page renders, workspace page renders, harness toggles still work (one click each way). `lighthouse_audit` accessibility on /settings (score sanity, no new a11y errors).
- [ ] **Step 5:** Kill the test instance (tracked background task), remove the temp DB. Commit any UI fixes found: `fix(ui): ...`

---

### Task 15: Docs, stale-rule fix, final verification

**Files:**
- Modify: `docs/overview.md` (feature summary in architecture + security posture: E2EE protects the server/remote boundary, metadata plaintext, local-OS-user NOT protected)
- Modify: `README.md` (short "Channels & cross-session orchestration" section + `MOTE_*` env vars + claude-code-only v1 note)
- Rewrite: `.claude/rules/security-context.md` — remove the false "no authentication / API intentionally open" claims (pre-existing staleness flagged during design): describe real posture (better-auth cookie + api-key bearer, localhost default, admin-gated surfaces) and keep the "if this ever leaves the LAN…" checklist, extended with: system keys are bearer-full-access, rotate via Settings.
- Modify: `CHANGELOG.md` if the file's existing style has entries (inspect first; follow the format).
- [ ] **Steps:** write docs → `bun run verify-types && bun run lint:check && bun run test && turbo build` all green → final commit `docs: cross-session comms architecture, env vars, and security posture refresh`.

---

## Self-review record

- **Spec coverage:** §4 arch → T9/T10; §5 schema → T2 (+recipient-table amendment); §6 REST → T6/T7; §7 tools → T9; §8 auth → T4/T5/T11; §9 session-mgr → T7/T10; §10 UI → T12; §11 errors → encoded in T6/T7/T9 tests; §12 posture → T15; §13 testing → T1 spike, per-task TDD, T13, T14. A2A is docs-only (no task needed).
- **Type consistency:** repos/guard/tool names fixed once here and reused verbatim in later tasks' Interfaces blocks.
- **Known risk points** (verify at the marked spike step, fix-forward allowed): MCP SDK v2 surface, api-key endpoint shapes, `updateApiKey` extend semantics.
