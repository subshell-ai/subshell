import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as grantsMigration from "@/db/migrations/0050-ssh-grants.js";
import * as destinationMigration from "@/db/migrations/0051-ssh-request-destination.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  sshGrantRequests: Record<string, unknown>;
}

/**
 * Task 12's one storage change: `ssh_grant_requests` gains `destination`, the
 * full resolved `user@host:port` the asking launch dialed. Nullable on
 * purpose (a pre-T12 pending row cannot be back-filled, and approval fails
 * closed on null); everything else 0050 froze stays untouched.
 */
describe("migration 0051-ssh-request-destination", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  beforeAll(async () => {
    dbFile = `/tmp/subshell-0051-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({
      dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }),
      plugins: [new CamelCasePlugin()],
    });
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT)`.execute(db);
    await sql`INSERT INTO user (id, name, email) VALUES ('u1', 'Owner', 'u1@test')`.execute(db);
    await grantsMigration.up(db);
    await destinationMigration.up(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("adds destination as a nullable column on the request row", async () => {
    const cols = await sql<{ name: string; notnull: number }>`
      SELECT name, "notnull" FROM pragma_table_info('ssh_grant_requests')
    `.execute(db);
    const names = cols.rows.map((r) => r.name);
    expect(names).toContain("destination");
    const destination = cols.rows.find((r) => r.name === "destination");
    expect(destination?.notnull).toBe(0); // legacy pending rows carry null; approval refuses them by name
  });

  it("an old-shaped row still inserts (null destination) and a full one round-trips", async () => {
    await db
      .insertInto("sshGrantRequests")
      .values({
        id: "req-legacy",
        ownerUserId: "u1",
        keyHomeNodeId: "n-a",
        resolvedSelector: "git.example.test",
        requestedFingerprints: null,
        paneId: "p1",
        bNodeId: "n-b",
        expiresAt: "2026-10-09T00:00:00.000Z",
        status: "pending",
        createdAt: "2026-10-08T00:00:00.000Z",
      } as never)
      .execute();
    await db
      .insertInto("sshGrantRequests")
      .values({
        id: "req-full",
        ownerUserId: "u1",
        keyHomeNodeId: "n-a",
        resolvedSelector: "git.example.test",
        requestedFingerprints: null,
        paneId: "p2",
        bNodeId: "n-b",
        expiresAt: "2026-10-09T00:00:00.000Z",
        status: "pending",
        createdAt: "2026-10-08T00:00:00.000Z",
        destination: "deploy@git.example.test:2222",
      } as never)
      .execute();
    const rows = await db.selectFrom("sshGrantRequests").select(["id", "destination"]).execute();
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: "req-legacy", destination: null },
        { id: "req-full", destination: "deploy@git.example.test:2222" },
      ]),
    );
  });

  it("down() removes only the new column and keeps the 0050 tables", async () => {
    await destinationMigration.down(db);
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('ssh_grant_requests')`.execute(db);
    expect(cols.rows.map((r) => r.name)).not.toContain("destination");
    expect(await db.selectFrom("sshHostPins").selectAll().execute()).toEqual([]);
  });
});
