import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as grantsMigration from "@/db/migrations/0050-ssh-grants.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  sshKeyGrants: Record<string, unknown>;
  sshGrantRequests: Record<string, unknown>;
  sshHostPins: Record<string, unknown>;
}

/**
 * The grant tier's storage (spec 2026-10-08 §6, §9; migration 0050) creates
 * ALL THREE tables in one file per the plan's file map: `ssh_key_grants` (the
 * standing authorization), `ssh_grant_requests` (the durable first-use queue
 * with an expiry deadline and a four-state lifecycle), and `ssh_host_pins`
 * (the M2 TOFU store - one unique pin per owner per resolved `user@host:port`;
 * its read/write logic is T12's, the SHAPE is this migration's).
 *
 * The FK target is the minimal `user` table (same posture as the 0048/0049
 * tests); node ids carry NO fk by design (a vanished node is refused at the
 * gate, the saved-hosts precedent).
 */
describe("migration 0050-ssh-grants", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0050-${Math.random().toString(36).slice(2)}.db`;
    // The app's own camelCase mapping (db/index.ts), so the typed inserts here
    // spell names the same way every repository does.
    db = new Kysely<MigrationDatabase>({
      dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }),
      plugins: [new CamelCasePlugin()],
    });
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT)`.execute(db);
    await sql`INSERT INTO user (id, name, email) VALUES ('u1', 'Owner', 'u1@test')`.execute(db);
    await grantsMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("creates ssh_key_grants with the full column set and rejects a null owner", async () => {
    const cols = await sql<{
      name: string;
      notnull: number;
    }>`SELECT name, "notnull" FROM pragma_table_info('ssh_key_grants')`.execute(db);
    const byName = new Map(cols.rows.map((c) => [c.name, c.notnull]));
    for (const col of [
      "id",
      "owner_user_id",
      "name",
      "key_home_node_id",
      "resolved_selector",
      "fingerprints",
      "created_via",
      "created_at",
      "updated_at",
    ]) {
      expect(byName.has(col)).toBe(true);
    }
    // EVERY grant column is NOT NULL: the service writes the full row, there is
    // no partial vocabulary (a grant with no fingerprints is an empty ARRAY,
    // not a NULL - "names no fingerprint serves nothing" is data, not absence).
    for (const col of [
      "owner_user_id",
      "name",
      "key_home_node_id",
      "resolved_selector",
      "fingerprints",
      "created_via",
      "created_at",
      "updated_at",
    ]) {
      expect(byName.get(col)).toBe(1);
    }
    await db
      .insertInto("sshKeyGrants")
      .values({
        id: "g1",
        ownerUserId: "u1",
        name: "work hosts",
        keyHomeNodeId: "node-a",
        resolvedSelector: "git.example.test",
        fingerprints: JSON.stringify(["SHA256:aaa"]),
        createdVia: "first-use",
        createdAt: "2026-10-08T00:00:00.000Z",
        updatedAt: "2026-10-08T00:00:00.000Z",
      })
      .execute();
    // The fingerprints column round-trips the JSON array exactly as stored.
    const row = await sql<{ fingerprints: string }>`SELECT fingerprints FROM ssh_key_grants WHERE id = 'g1'`.execute(
      db,
    );
    expect(JSON.parse(row.rows[0].fingerprints)).toEqual(["SHA256:aaa"]);
    // NOT NULL enforced at the door: a grant row without its owner is refused.
    await expect(
      db
        .insertInto("sshKeyGrants")
        .values({
          id: "g2",
          ownerUserId: null as unknown as string,
          name: "n",
          keyHomeNodeId: "node-a",
          resolvedSelector: "h",
          fingerprints: "[]",
          createdVia: "manual",
          createdAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-08T00:00:00.000Z",
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("creates ssh_grant_requests: only requested_fingerprints is nullable, and a durable pending row round-trips", async () => {
    const cols = await sql<{
      name: string;
      notnull: number;
    }>`SELECT name, "notnull" FROM pragma_table_info('ssh_grant_requests')`.execute(db);
    const byName = new Map(cols.rows.map((c) => [c.name, c.notnull]));
    // (`id` is deliberately absent: SQLite's TEXT PRIMARY KEY carries no
    // NOT NULL flag, and uniqueness is the actual identity rule here.)
    for (const col of [
      "owner_user_id",
      "key_home_node_id",
      "resolved_selector",
      "pane_id",
      "b_node_id",
      "expires_at",
      "status",
      "created_at",
    ]) {
      expect(byName.get(col)).toBe(1);
    }
    // The one representable absence (spec §6.2: the approver, not the pane,
    // selects the keys): a request with no pre-selection stores NULL.
    expect(byName.get("requested_fingerprints")).toBe(0);
    await db
      .insertInto("sshGrantRequests")
      .values({
        id: "r1",
        ownerUserId: "u1",
        keyHomeNodeId: "node-a",
        resolvedSelector: "git.example.test",
        requestedFingerprints: null,
        paneId: "pane-1",
        bNodeId: "node-b",
        expiresAt: "2026-10-09T00:00:00.000Z",
        status: "pending",
        createdAt: "2026-10-08T00:00:00.000Z",
      })
      .execute();
    // (Raw SQL identifiers stay snake - the plugin rewrites the Kysely
    // builders, not raw text - but the RESULT ROW KEYS come back camel, the
    // mapping the app's own queries ride everywhere.)
    const back = await sql<{ status: string; requestedFingerprints: string | null; paneId: string }>`
      SELECT status, requested_fingerprints, pane_id FROM ssh_grant_requests WHERE id = 'r1'
    `.execute(db);
    expect(back.rows[0].status).toBe("pending");
    expect(back.rows[0].requestedFingerprints).toBeNull();
    // The requester facts ride the row (the approvals screen shows WHO asked):
    // the row survives because the table is durable storage, not process state.
    expect(back.rows[0].paneId).toBe("pane-1");
    // A terminal status re-uses the same column vocabulary (no CHECK in this
    // schema: the SERVICE validates against SSH_GRANT_REQUEST_STATUSES).
    await sql`UPDATE ssh_grant_requests SET status = 'approved' WHERE id = 'r1'`.execute(db);
    const after = await sql<{ status: string }>`SELECT status FROM ssh_grant_requests WHERE id = 'r1'`.execute(db);
    expect(after.rows[0].status).toBe("approved");
  });

  it("creates ssh_host_pins with the unique (owner, destination) key - the TOFU record shape", async () => {
    await db
      .insertInto("sshHostPins")
      .values({
        id: "p1",
        ownerUserId: "u1",
        destination: "git@git.example.test:22",
        hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPin",
        createdAt: "2026-10-08T00:00:00.000Z",
        updatedAt: "2026-10-08T00:00:00.000Z",
      })
      .execute();
    // One pin per owner per resolved destination: the second insert at the
    // same key is the §9 hard block at the STORAGE level (the capture logic
    // that reads this refusal is T12's).
    await expect(
      db
        .insertInto("sshHostPins")
        .values({
          id: "p2",
          ownerUserId: "u1",
          destination: "git@git.example.test:22",
          hostKey: "ssh-ed25519 AAAAC3DIFFERENT",
          createdAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-08T00:00:00.000Z",
        })
        .execute(),
    ).rejects.toThrow();
    // Another owner may hold their own pin for the same destination (per-owner
    // scoping: one account's first use must not poison or lock another's).
    await sql`INSERT INTO user (id, name, email) VALUES ('u2', 'Other', 'u2@test')`.execute(db);
    await db
      .insertInto("sshHostPins")
      .values({
        id: "p3",
        ownerUserId: "u2",
        destination: "git@git.example.test:22",
        hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPin",
        createdAt: "2026-10-08T00:00:00.000Z",
        updatedAt: "2026-10-08T00:00:00.000Z",
      })
      .execute();
    const count = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ssh_host_pins`.execute(db);
    expect(count.rows[0].n).toBe(2);
  });

  it("owner deletion cascades every grant tier row (accounts leave no authorization behind)", async () => {
    await sql`DELETE FROM user WHERE id = 'u2'`.execute(db);
    const orphans = await sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM ssh_host_pins WHERE owner_user_id = 'u2'`.execute(db);
    expect(orphans.rows[0].n).toBe(0);
  });

  it("down drops all three tables", async () => {
    await grantsMigration.down(db);
    for (const table of ["ssh_key_grants", "ssh_grant_requests", "ssh_host_pins"]) {
      const left = await sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ${table}
      `.execute(db);
      expect(left.rows[0].n).toBe(0);
    }
  });
});
