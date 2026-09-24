import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { getMigrations } from "better-auth/db/migration";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { AUTH_OPTIONS } from "@/auth.js";
import * as renameMigration from "@/db/migrations/0019-subshell-rename.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * Focused coverage for migration 0019's BEARER-KEY rewrite — the one step of
 * the sessions→subshells migration that mutates data, not schema. Per-subshell
 * tokens minted before the rename carry `{kind:"session",sessionId}` metadata
 * (the auth-guard discriminator, see `src/api/auth-guard.ts` meta.kind/meta
 * .subshellId) and a `sessions` permission key (`requirePerm`'s vocabulary);
 * `up()` must migrate both to the CURRENT reader shape without disturbing
 * rows of the other key kinds (system/node).
 *
 * Schema scope: only better-auth's real tables are built here (via the same
 * `getMigrations` call the boot path runs — the app never hand-rolls the
 * apikey DDL, it predates Kysely). The app-table renames are guarded on
 * existence for exactly this kind of partial schema, so they are no-ops in
 * this file; they are covered by every suite that boots the full migration
 * history through `setupAuthTables`.
 */

const NOW = "2026-09-02T00:00:00.000Z";

/** Opens a private in-memory DB carrying better-auth's REAL schema. */
async function apikeyDb(): Promise<{ db: Kysely<any>; handle: Database }> {
  const handle = openSqliteDatabase(":memory:");
  // Full options (plugins included) so the api-key plugin's `apikey` table
  // is created — same call shape as `runAuthMigrations()` at boot.
  const migration = await getMigrations({ ...AUTH_OPTIONS, database: handle, logger: { level: "error" } });
  await migration.runMigrations();
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => handle }),
    plugins: [new CamelCasePlugin()],
  });
  return { db, handle };
}

/** Seeds one apikey row through the raw handle (better-auth's physical camelCase columns). */
function seedKey(handle: Database, row: { id: string; metadata: string; permissions: string }): void {
  handle.run(
    `INSERT INTO apikey (id, "configId", name, "referenceId", "key", "createdAt", "updatedAt", metadata, permissions)
     VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, `key-${row.id}`, "u1", `hash-${row.id}`, NOW, NOW, row.metadata, row.permissions],
  );
}

/** Reads back the two JSON columns the rewrite touches. */
function readKey(handle: Database, id: string): { metadata: string | null; permissions: string | null } {
  const row = handle
    .prepare<{ metadata: string | null; permissions: string | null }, [string]>(
      "SELECT metadata, permissions FROM apikey WHERE id = ?",
    )
    .get(id);
  if (!row) throw new Error(`apikey row ${id} missing`);
  return row;
}

/** The exact legacy shape `up()` rewrites (pre-rename session-tokens mint). */
const LEGACY_META = JSON.stringify({ name: "sess:legacy", kind: "session", sessionId: "sess-123" });
const LEGACY_PERMS = JSON.stringify({ channels: ["read", "write"], sessions: ["read", "write"] });

describe("migration 0019-subshell-rename: apikey rewrite", () => {
  it("up() rewrites legacy session-key metadata to the current reader shape", async () => {
    const { db, handle } = await apikeyDb();
    seedKey(handle, { id: "k-legacy", metadata: LEGACY_META, permissions: LEGACY_PERMS });

    await renameMigration.up(db);

    const row = readKey(handle, "k-legacy");
    if (!row.metadata || !row.permissions) throw new Error("apikey columns missing on k-legacy");
    // Parse-compare (json_patch preserves unrelated keys; may reorder others).
    expect(JSON.parse(row.metadata)).toEqual({
      name: "sess:legacy", // untouched keys survive the patch
      kind: "subshell", // auth-guard's discriminator (meta.kind === "subshell")
      subshellId: "sess-123", // auth-guard's id read (typeof meta.subshellId === "string")
    });
    // requirePerm's resource vocabulary: `subshells`, not `sessions`.
    expect(JSON.parse(row.permissions)).toEqual({
      channels: ["read", "write"],
      subshells: ["read", "write"],
    });
  });

  it("up() leaves system- and node-kind rows untouched", async () => {
    const { db, handle } = await apikeyDb();
    seedKey(handle, { id: "k-system", metadata: '{"kind":"system"}', permissions: '{"*":["*"]}' });
    seedKey(handle, {
      id: "k-node",
      metadata: '{"kind":"node","nodeId":"n1"}',
      permissions: JSON.stringify({ channels: ["read"] }),
    });

    await renameMigration.up(db);

    expect(readKey(handle, "k-system")).toEqual({
      metadata: '{"kind":"system"}',
      permissions: '{"*":["*"]}',
    });
    expect(readKey(handle, "k-node")).toEqual({
      metadata: '{"kind":"node","nodeId":"n1"}',
      permissions: '{"channels":["read"]}',
    });
  });

  it("down() reverses the rewrite and up() re-applies it (roundtrip)", async () => {
    const { db, handle } = await apikeyDb();
    seedKey(handle, { id: "k-legacy", metadata: LEGACY_META, permissions: LEGACY_PERMS });
    seedKey(handle, { id: "k-system", metadata: '{"kind":"system"}', permissions: '{"*":["*"]}' });

    await renameMigration.up(db);
    await renameMigration.down(db);

    // Back to exactly what the pre-rename mint wrote.
    const reverted = readKey(handle, "k-legacy");
    if (!reverted.metadata || !reverted.permissions) throw new Error("apikey columns missing on k-legacy");
    expect(JSON.parse(reverted.metadata)).toEqual({ name: "sess:legacy", kind: "session", sessionId: "sess-123" });
    expect(JSON.parse(reverted.permissions)).toEqual({ channels: ["read", "write"], sessions: ["read", "write"] });
    // The down() metadata pass is gated on kind === "subshell" — a system key
    // must never gain a phantom sessionId.
    expect(readKey(handle, "k-system")).toEqual({ metadata: '{"kind":"system"}', permissions: '{"*":["*"]}' });

    await renameMigration.up(db);
    const reupped = readKey(handle, "k-legacy");
    if (!reupped.metadata || !reupped.permissions) throw new Error("apikey columns missing on k-legacy");
    expect(JSON.parse(reupped.metadata)).toEqual({
      name: "sess:legacy",
      kind: "subshell",
      subshellId: "sess-123",
    });
    expect(JSON.parse(reupped.permissions)).toEqual({
      channels: ["read", "write"],
      subshells: ["read", "write"],
    });
  });
});
