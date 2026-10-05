import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { down as down0047, up as up0047 } from "@/db/migrations/0047-ssh-connections.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * `ssh_connections` + `ssh_grants` (SSH-SUPPORT.md §4, Gate A). What this
 * pins is the schema the whole feature reads: the revision default, the
 * node/owner/pane cascades, and above all the PARTIAL uniqueness of active
 * grants - "unique ACTIVE binding per tuple", with revoked history kept and
 * re-granting allowed. The FK targets are minimal mirror tables in the same
 * posture as the 0040 test.
 */
interface MigrationDb {
  user: { id: string };
  nodes: { id: string };
  subshells: { id: string };
  // Defaulted columns are optional in the insert shape (the 0040 precedent):
  // the point of those defaults is what the bare `values()` rows exercise.
  sshConnections: {
    id: string;
    userId: string;
    nodeId: string;
    displayName: string;
    configSnapshot: string;
    remoteDir: string | null;
    revision?: number;
    createdAt?: string;
    updatedAt?: string;
  };
  sshGrants: {
    id: string;
    connectionId: string;
    connectionRevision: number;
    subshellId: string;
    apiKeyId: string;
    grantedByUserId: string;
    grantedAt?: string;
    revokedAt: string | null;
  };
}

const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("0047 ssh connections/grants migration", () => {
  let dbFile: string;
  let sqlite: ReturnType<typeof openSqliteDatabase>;
  let db: Kysely<MigrationDb>;

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0047-${Math.random().toString(36).slice(2)}.db`;
    sqlite = openSqliteDatabase(dbFile);
    db = new Kysely<MigrationDb>({
      dialect: new BunSqliteDialect({ database: sqlite }),
      plugins: [new CamelCasePlugin()],
    });
    // FK targets, minimally shaped (same posture as the 0040 test mirroring
    // better-auth's user row): only `id` matters to these two tables.
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT)`.execute(db);
    await sql`CREATE TABLE nodes (id TEXT PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE subshells (id TEXT PRIMARY KEY)`.execute(db);
    await sql`INSERT INTO user (id, name, email) VALUES ('u1', 'Owner', 'u1@subshell.local')`.execute(db);
    await sql`INSERT INTO nodes (id) VALUES ('n1')`.execute(db);
    await sql`INSERT INTO subshells (id) VALUES ('p1'), ('p2')`.execute(db);
    await up0047(db as unknown as Kysely<never>);
  });

  afterAll(async () => {
    await db.destroy();
    sqlite.close();
    await Bun.file(dbFile)
      .unlink()
      .catch(() => {});
  });

  async function insertConnection(id: string): Promise<void> {
    await db
      .insertInto("sshConnections")
      .values({ id, userId: "u1", nodeId: "n1", displayName: "Staging", configSnapshot: '{"host":"h"}' })
      .execute();
  }

  async function insertGrant(id: string, subshellId: string, apiKeyId = "k1", revoked = false): Promise<void> {
    await db
      .insertInto("sshGrants")
      .values({
        id,
        connectionId: "c1",
        connectionRevision: 1,
        subshellId,
        apiKeyId,
        grantedByUserId: "u1",
        revokedAt: revoked ? "2026-10-04T00:00:00.000Z" : null,
      })
      .execute();
  }

  it("inserts a connection with revision 1 and ISO UTC default stamps", async () => {
    await insertConnection("c1");
    const row = await db.selectFrom("sshConnections").where("id", "=", "c1").selectAll().executeTakeFirstOrThrow();
    expect(row.revision).toBe(1);
    expect(row.remoteDir).toBeNull();
    expect(typeof row.createdAt).toBe("string");
    expect(typeof row.updatedAt).toBe("string");
    expect(isoUtc.test(row.createdAt as string)).toBe(true);
    expect(isoUtc.test(row.updatedAt as string)).toBe(true);
  });

  it("keeps at most one ACTIVE grant per (connection, pane, key) tuple", async () => {
    await insertGrant("g1", "p1");
    // Same tuple, still active: the partial unique index refuses it.
    await expect(insertGrant("g2", "p1")).rejects.toThrow();
    // A DIFFERENT key for the same pane is a different tuple - the rotated
    // pane needs its own grant row, and the grammar allows exactly that.
    await insertGrant("g3", "p1", "k2");
    // A different pane is a different tuple too.
    await insertGrant("g4", "p2");
  });

  it("keeps revoked rows as history and lets the same tuple be re-granted", async () => {
    await db.updateTable("sshGrants").set({ revokedAt: "2026-10-04T12:00:00.000Z" }).where("id", "=", "g1").execute();
    // g1's tuple is (c1, p1, k1) and now inactive: a fresh active row fits.
    await insertGrant("g5", "p1", "k1");
    const active = await db
      .selectFrom("sshGrants")
      .selectAll()
      .where("connectionId", "=", "c1")
      .where("subshellId", "=", "p1")
      .where("apiKeyId", "=", "k1")
      .where("revokedAt", "is", null)
      .execute();
    expect(active).toHaveLength(1);
    // The revoked history row is STILL there - runs reference it by id.
    const history = await db.selectFrom("sshGrants").selectAll().where("id", "=", "g1").executeTakeFirst();
    expect(history?.revokedAt).toBe("2026-10-04T12:00:00.000Z");
  });

  it("cascades grants with the pane and connections with the node", async () => {
    await sql`DELETE FROM subshells WHERE id = 'p2'`.execute(db);
    const gone = await db.selectFrom("sshGrants").selectAll().where("id", "=", "g4").executeTakeFirst();
    expect(gone).toBeUndefined();
    // The node cascade takes connections AND (via connection cascade) grants.
    await sql`DELETE FROM nodes WHERE id = 'n1'`.execute(db);
    const conn = await db.selectFrom("sshConnections").selectAll().where("id", "=", "c1").executeTakeFirst();
    expect(conn).toBeUndefined();
    const grants = await db.selectFrom("sshGrants").selectAll().where("connectionId", "=", "c1").execute();
    expect(grants).toHaveLength(0);
    // Restore for any later expectations.
    await sql`INSERT INTO nodes (id) VALUES ('n1')`.execute(db);
  });

  it("down drops both tables and their indexes", async () => {
    await down0047(db as unknown as Kysely<never>);
    for (const name of ["ssh_connections", "ssh_grants"]) {
      const r = await sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`.execute(db);
      expect(r.rows).toHaveLength(0);
    }
  });
});
