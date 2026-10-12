import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as channelsMigration from "@/db/migrations/0009-channels.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as relayIdentityMigration from "@/db/migrations/0049-ssh-relay-identity.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  identities: Record<string, unknown>;
  nodes: Record<string, unknown>;
}

/**
 * The relay identity tier's storage (spec 2026-10-08 §4.2, §4.5, §9):
 * `identities.signing_public_key`, the machine's ES256 signing slot beside the
 * ECDH-ES encryption key, and `nodes.ssh_fingerprint`, the durable mirror of
 * the runtime fingerprint block so the trust card survives an offline node.
 * Both are nullable by design: a pre-M2 row simply carries nothing yet.
 */
describe("migration 0049-ssh-relay-identity", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0049-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    // The FK target, minimally shaped (same posture as the 0048 test); 0009
    // additionally adds a column to the `sessions` table 0001 creates.
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT)`.execute(db);
    await initMigration.up(db);
    await channelsMigration.up(db);
    await nodesMigration.up(db);
    // Written BEFORE the columns exist - the upgrade case: a pre-M2 principal
    // and a pre-M2 node row both read NULL for both new slots.
    await db
      .insertInto("identities")
      .values({
        principal_id: "node:pre-m2",
        public_key: '{"kty":"EC","crv":"P-256","x":"AAA","y":"BBB"}',
        display_name: "old box",
      })
      .execute();
    await db
      .insertInto("nodes")
      .values({
        id: "node-pre-m2",
        owner_user_id: "u1",
        name: "old box",
        kind: "agent",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      })
      .execute();
    await relayIdentityMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("adds signing_public_key to identities; a pre-M2 registration reads NULL", async () => {
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('identities')`.execute(db);
    expect(cols.rows.map((c) => c.name)).toContain("signing_public_key");
    const r = await sql<{ signing_public_key: string | null }>`
      SELECT signing_public_key FROM identities WHERE principal_id = 'node:pre-m2'
    `.execute(db);
    expect(r.rows[0].signing_public_key).toBeNull();
    // The signing slot stores the registered JWK text and reads back; the
    // encryption key beside it is untouched (same record, §4.2).
    const signing = '{"kty":"EC","crv":"P-256","x":"CCC","y":"DDD"}';
    await sql`UPDATE identities SET signing_public_key = ${signing} WHERE principal_id = 'node:pre-m2'`.execute(db);
    const back = await sql<{ signing_public_key: string; public_key: string }>`
      SELECT signing_public_key, public_key FROM identities WHERE principal_id = 'node:pre-m2'
    `.execute(db);
    expect(back.rows[0].signing_public_key).toBe(signing);
    expect(back.rows[0].public_key).toBe('{"kty":"EC","crv":"P-256","x":"AAA","y":"BBB"}');
  });

  it("adds ssh_fingerprint to nodes; a pre-M2 row reads NULL and a mirror round-trips", async () => {
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    expect(cols.rows.map((c) => c.name)).toContain("ssh_fingerprint");
    const r = await sql<{ ssh_fingerprint: string | null }>`
      SELECT ssh_fingerprint FROM nodes WHERE id = 'node-pre-m2'
    `.execute(db);
    expect(r.rows[0].ssh_fingerprint).toBeNull();
    // The mirror block is JSON text (the §4.5 trust card data), written by a
    // later task when the agent reports.
    const block = JSON.stringify({ signing: "SHA256:aaa", encryption: "SHA256:bbb", reportedAt: "now" });
    await sql`UPDATE nodes SET ssh_fingerprint = ${block} WHERE id = 'node-pre-m2'`.execute(db);
    const back = await sql<{ ssh_fingerprint: string }>`
      SELECT ssh_fingerprint FROM nodes WHERE id = 'node-pre-m2'
    `.execute(db);
    expect(back.rows[0].ssh_fingerprint).toBe(block);
  });

  it("neither column is NOT NULL: a fresh insert without them succeeds", async () => {
    // The identities side of the claim: a post-migration registration that
    // OMITS the signing slot must land, with the column NULL, not fail NOT NULL.
    await db
      .insertInto("identities")
      .values({
        principal_id: "node:fresh-null",
        public_key: '{"kty":"EC","crv":"P-256","x":"EEE","y":"FFF"}',
        display_name: "fresh box",
      })
      .execute();
    const ri = await sql<{ signing_public_key: string | null }>`
      SELECT signing_public_key FROM identities WHERE principal_id = 'node:fresh-null'
    `.execute(db);
    expect(ri.rows[0].signing_public_key).toBeNull();
    await db
      .insertInto("nodes")
      .values({
        id: "node-post-m2",
        owner_user_id: "u1",
        name: "new box",
        kind: "agent",
        created_at: "2026-10-08T00:00:00.000Z",
        updated_at: "2026-10-08T00:00:00.000Z",
      })
      .execute();
    const r = await sql<{ ssh_fingerprint: string | null }>`
      SELECT ssh_fingerprint FROM nodes WHERE id = 'node-post-m2'
    `.execute(db);
    expect(r.rows[0].ssh_fingerprint).toBeNull();
  });

  it("down drops both columns and leaves the rows", async () => {
    await relayIdentityMigration.down(db);
    const identityCols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('identities')`.execute(db);
    expect(identityCols.rows.map((c) => c.name)).not.toContain("signing_public_key");
    const nodeCols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('nodes')`.execute(db);
    expect(nodeCols.rows.map((c) => c.name)).not.toContain("ssh_fingerprint");
    const left = await sql<{ id: string }>`SELECT id FROM nodes ORDER BY id`.execute(db);
    expect(left.rows.map((r) => r.id)).toEqual(["node-post-m2", "node-pre-m2"]);
  });
});
