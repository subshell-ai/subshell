import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { down, up } from "../0064-node-virtual-display-enabled.js";

it("preserves the old combined grant but defaults newly enrolled nodes off", async () => {
  const db = new Kysely<any>({ dialect: new BunSqliteDialect({ database: new Database(":memory:") }) });
  try {
    await sql`create table nodes (id text, preview_enabled integer not null default 0)`.execute(db);
    await sql`insert into nodes values ('enabled', 1), ('disabled', 0)`.execute(db);
    await up(db);
    await sql`insert into nodes (id) values ('new')`.execute(db);
    const rows = await sql<{
      id: string;
      virtual_display_enabled: number;
    }>`select id, virtual_display_enabled from nodes order by id`.execute(db);
    expect(rows.rows).toEqual([
      { id: "disabled", virtual_display_enabled: 0 },
      { id: "enabled", virtual_display_enabled: 1 },
      { id: "new", virtual_display_enabled: 0 },
    ]);
    await down(db);
    await up(db);
    expect((await sql`select * from nodes`.execute(db)).rows).toHaveLength(3);
  } finally {
    await db.destroy();
  }
});
