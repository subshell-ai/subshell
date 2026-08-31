import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import { up as up0010 } from "@/db/migrations/0010-profile-default-flag.js";
import { openSqliteDatabase } from "@/db/open-database.js";

interface MigrationDatabase {
  [table: string]: Record<string, unknown>;
  profiles: Record<string, unknown>;
}

/**
 * The unremovable-Defaults flag: a NOT NULL is_default column (0 for existing
 * rows), and a backfill that adopts ONLY the seeder's complete blank shape.
 * The false-positive cases matter most: POST /api/profiles stores omitted
 * optional fields as NULL, so a hand-made "Default" that configured anything
 * else — even one field — must stay deletable.
 */
describe("0010 profile default-flag migration", () => {
  let dbFile: string;
  let db: Kysely<MigrationDatabase>;

  /** Raw insert — the untyped migration DB keeps snake_case columns. */
  async function seedProfile(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const id = `${name.replace(/\s/g, "")}-${Math.random().toString(36).slice(2)}`;
    await db
      .insertInto("profiles")
      .values({ id, user_id: "u1", harness_id: "claude-code", name, ...extra })
      .execute();
    return id;
  }

  let blankId: string;

  beforeAll(async () => {
    dbFile = `/tmp/mote-0010-${Math.random().toString(36).slice(2)}.db`;
    db = new Kysely<MigrationDatabase>({ dialect: new BunSqliteDialect({ database: openSqliteDatabase(dbFile) }) });
    await initMigration.up(db);
    await remoteOpsMigration.up(db); // profiles gains restart_on_exit
    blankId = await seedProfile("Default"); // the seeder's exact shape -> adopted
    await seedProfile("Default", { env_json: '{"A":"1"}' }); // configured -> left alone
    // Hand-made rows that merely OMIT the optional JSON fields (what the POST
    // route stores) but configured something else — must NOT be adopted:
    await seedProfile("Default", { restart_on_exit: 1 });
    await seedProfile("Default", { description: "mine" });
    await seedProfile("Default", { config_isolation: 1 });
    await seedProfile("My Default"); // name-alike -> left alone
    await up0010(db);
  });

  afterAll(() => {
    Bun.file(dbFile)
      .unlink()
      .catch(() => {});
  });

  it("adds is_default NOT NULL default 0", async () => {
    const cols = await sql<{ name: string }>`SELECT name FROM pragma_table_info('profiles')`.execute(db);
    expect(cols.rows.map((c) => c.name)).toContain("is_default");
    // A post-migration insert that omits the column gets the DB default.
    const id = await seedProfile("Fresh");
    const row = await db.selectFrom("profiles").select("is_default").where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.is_default).toBe(0);
  });

  it("adopts only the row matching the seeder's complete blank shape", async () => {
    const flagged = await db.selectFrom("profiles").select("id").where("is_default", "=", 1).execute();
    expect(flagged.map((r) => r.id)).toEqual([blankId]);
  });
});
