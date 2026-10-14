import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as profileDefaultFlagMigration from "@/db/migrations/0010-profile-default-flag.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as sshLaunchMigration from "@/db/migrations/0048-ssh-launch-and-saved-hosts.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { sshCanonicalDestination } from "@/db/types/ssh-saved-hosts.db-types.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  ssh_saved_hosts: Record<string, unknown>;
  subshells: Record<string, unknown>;
  user: Record<string, unknown>;
}

/**
 * The SSH launcher tier's storage (spec 2026-10-07 §7): the `ssh_saved_hosts`
 * destination ledger (keyed on the canonical destination, unique per owner,
 * recency ordered) and `subshells.ssh`, the nullable snapshot column whose
 * presence is the owner-only-input rule's trigger.
 */
describe("migration 0048-ssh-launch-and-saved-hosts", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  /** Insert a subshell row the way the pre-0048 repository did - no ssh column at all. */
  const legacySubshell = (id: string) =>
    db
      .insertInto("subshells")
      .values({
        id,
        user_id: "u1",
        profile_id: "p1",
        harness_id: "claude-code",
        name: id,
        working_dir: "/tmp",
      })
      .execute();

  /** A ledger row as the (future) service writes it: full key, live node, connect stamp. */
  const savedHost = (id: string, destination: string, ownerUserId = "u1") =>
    db
      .insertInto("ssh_saved_hosts")
      .values({
        id,
        owner_user_id: ownerUserId,
        destination,
        alias: null,
        node_id: "local",
        saved_at: null,
        last_connect_at: "2026-10-07T00:00:00.000Z",
      })
      .execute();

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0048-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    // The FK target: better-auth's user table, minimally shaped so
    // `references("user.id")` resolves on this throwaway file (same posture
    // as the 0040 test).
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT)`.execute(db);
    await sql`INSERT INTO user (id, name, email) VALUES ('u1', 'Owner', 'u1@subshell.local')`.execute(db);
    await initMigration.up(db);
    await remoteOpsMigration.up(db);
    await profileDefaultFlagMigration.up(db);
    await nodesMigration.up(db);
    await subshellRenameMigration.up(db);
    // Written BEFORE the column exists - the upgrade case: a pre-ssh pane reads NULL.
    await legacySubshell("pre-existing");
    await sshLaunchMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("creates ssh_saved_hosts with the ledger's seven columns", async () => {
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('ssh_saved_hosts')`.execute(db);
    expect(cols.rows.map((c) => c.name)).toEqual([
      "id",
      "owner_user_id",
      "destination",
      "alias",
      "node_id",
      "saved_at",
      "last_connect_at",
    ]);
  });

  it("adds the nullable ssh snapshot column; a pre-existing pane reads NULL", async () => {
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('subshells')`.execute(db);
    expect(cols.rows.map((c) => c.name)).toContain("ssh");
    const r = await sql<{ ssh: string | null }>`SELECT ssh FROM subshells WHERE id = 'pre-existing'`.execute(db);
    expect(r.rows[0].ssh).toBeNull();
    // A launch row stores its approved snapshot as JSON text and reads back.
    const snapshot = JSON.stringify({ host: "example.test", port: 22, user: null });
    await sql`UPDATE subshells SET ssh = ${snapshot} WHERE id = 'pre-existing'`.execute(db);
    const back = await sql<{ ssh: string }>`SELECT ssh FROM subshells WHERE id = 'pre-existing'`.execute(db);
    expect(back.rows[0].ssh).toBe(snapshot);
    await sql`UPDATE subshells SET ssh = NULL WHERE id = 'pre-existing'`.execute(db);
  });

  it("carries the unique (owner_user_id, destination) index as the key", async () => {
    const lists = await sql<{ name: string; unique: number }>`
      SELECT name, "unique" FROM pragma_index_list('ssh_saved_hosts')
    `.execute(db);
    const unique = lists.rows.find((i) => i.name === "idx_ssh_saved_hosts_owner_destination");
    expect(unique).toEqual({ name: "idx_ssh_saved_hosts_owner_destination", unique: 1 });
    await savedHost("h1", "dev@example.test:22");
    // The same destination under one owner is the SAME row's subject, never a second one.
    await expect(savedHost("h2", "dev@example.test:22")).rejects.toThrow();
    // ...and under another owner it is a different person's ledger entry.
    await sql`INSERT INTO user (id, name, email) VALUES ('u2', 'Other', 'u2@subshell.local')`.execute(db);
    await savedHost("h3", "dev@example.test:22", "u2");
    const keys = await sql<{ owner_user_id: string }>`
      SELECT owner_user_id FROM ssh_saved_hosts WHERE destination = 'dev@example.test:22' ORDER BY owner_user_id
    `.execute(db);
    expect(keys.rows.map((r) => r.owner_user_id)).toEqual(["u1", "u2"]);
  });

  it("carries the recency index, last_connect_at DESC for one owner's list read", async () => {
    const lists = await sql<{ name: string }>`SELECT name FROM pragma_index_list('ssh_saved_hosts')`.execute(db);
    expect(lists.rows.map((i) => i.name)).toContain("idx_ssh_saved_hosts_owner_recent");
    // The direction is the point: the list read is newest-first, pinned in the DDL.
    const ddl = await sql<{ sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_ssh_saved_hosts_owner_recent'
    `.execute(db);
    expect(ddl.rows[0].sql).toMatch(/"last_connect_at" desc/);
  });

  it("requires the key parts and cascades the owner away", async () => {
    // last_connect_at is NOT NULL: every row is a connect record, saved or not.
    await expect(
      db
        .insertInto("ssh_saved_hosts")
        .values({
          id: "h-no-stamp",
          owner_user_id: "u1",
          destination: "x@y.test:22",
          alias: null,
          node_id: "local",
          saved_at: null,
        } as never)
        .execute(),
    ).rejects.toThrow();
    // Deleting the account drops its ledger (FK cascade, like every owner column).
    await savedHost("h-cascade", "gone@example.test:22", "u2");
    await sql`DELETE FROM user WHERE id = 'u2'`.execute(db);
    const left = await sql<{ id: string }>`SELECT id FROM ssh_saved_hosts WHERE owner_user_id = 'u2'`.execute(db);
    expect(left.rows).toEqual([]);
  });

  it("down drops the table and the snapshot column and leaves the panes", async () => {
    await sshLaunchMigration.down(db);
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ssh_saved_hosts'
    `.execute(db);
    expect(tables.rows).toEqual([]);
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('subshells')`.execute(db);
    expect(cols.rows.map((c) => c.name)).not.toContain("ssh");
    const left = await sql<{ id: string }>`SELECT id FROM subshells`.execute(db);
    expect(left.rows.map((r) => r.id)).toEqual(["pre-existing"]);
  });
});

/**
 * The canonical destination spelling (spec 2026-10-07 §7): `host:port` with an
 * optional `user@` prefix. The key of the ledger, so its three pinned shapes
 * are pinned here, at its only home.
 */
describe("sshCanonicalDestination", () => {
  it("prefixes the user when the snapshot carries one", () => {
    expect(sshCanonicalDestination({ host: "h", port: 22, user: "u" })).toBe("u@h:22");
  });

  it("spells a null user as a bare host:port, never an empty prefix", () => {
    expect(sshCanonicalDestination({ host: "h", port: 2222, user: null })).toBe("h:2222");
  });

  it("passes an already-bracketed IPv6 host through untouched", () => {
    expect(sshCanonicalDestination({ host: "[::1]", port: 22, user: null })).toBe("[::1]:22");
  });
});
