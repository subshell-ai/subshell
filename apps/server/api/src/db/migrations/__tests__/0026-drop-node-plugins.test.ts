import { beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import * as initMigration from "@/db/migrations/0001-init.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as nodePluginsMigration from "@/db/migrations/0023-node-plugins.js";
import * as dropNodePlugins from "@/db/migrations/0026-drop-node-plugins.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * Migration 0026: the plugin ownership move, both halves in one file.
 *
 * The instance-level `enabled` flag (spec 2026-09-10 §6.1) arrives in the
 * same change that drops the per-node mirror (`nodes.plugins_json` /
 * `nodes.plugins_at`, added in 0023). One change of ownership, not two
 * migrations — the mirror was the node declaring what it offers; the plane's
 * own store plus `plugin_state` is the answer now, and nothing reads the
 * mirror after the inversion (Task 9).
 *
 * The file was created as `0026-plugin-state` in Task 9 with only the CREATE
 * half and renamed here with the DROP half added. The rename is safe because
 * no released database exists, and it is *cheap* because `up` is idempotent:
 * a dev database that already recorded the old name re-runs the extended file
 * against a schema that has the table and not yet the drops, cleanly.
 *
 * Pinned here, in order:
 * - after `up`, `nodes` has NO plugins_json/plugins_at, and `plugin_state`
 *   exists with its three load-bearing columns;
 * - an absent `plugin_state` row means enabled (DEFAULT 1), and the plugin id
 *   is the PK — installing writes nothing;
 * - `up` is safe to run twice;
 * - `down` recreates the mirror columns EMPTY (nothing to reconstruct —
 *   0025's reasoning) and drops the table;
 * - the real boot path (`runMigrations`, i.e. the static provider map in
 *   `migrate.ts`) lands on the same schema — map key and file must agree.
 */
async function freshDb(): Promise<Kysely<any>> {
  const kysely = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(kysely);
  return kysely;
}

/** A database at the pre-0026 shape: `nodes` exists and carries the mirror. */
async function pre0026Db(): Promise<Kysely<any>> {
  const kysely = await freshDb();
  await nodesMigration.up(kysely);
  await nodePluginsMigration.up(kysely);
  return kysely;
}

async function columns(dbLike: Kysely<any> | typeof db, table: string): Promise<string[]> {
  const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(dbLike);
  return r.rows.map((c) => c.name);
}

async function hasTable(dbLike: Kysely<any> | typeof db, table: string): Promise<boolean> {
  const r = await sql<{
    n: number;
  }>`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=${table}`.execute(dbLike);
  return (r.rows[0]?.n ?? 0) > 0;
}

describe("migration 0026-drop-node-plugins", () => {
  it("drops plugins_json and plugins_at from nodes", async () => {
    const kysely = await pre0026Db();
    try {
      // precondition: 0023 put the mirror there
      expect(await columns(kysely, "nodes")).toContain("plugins_json");
      await dropNodePlugins.up(kysely);
      const after = await columns(kysely, "nodes");
      expect(after).not.toContain("plugins_json");
      expect(after).not.toContain("plugins_at");
    } finally {
      await kysely.destroy();
    }
  });

  it("creates plugin_state with the three load-bearing columns, beside the drop", async () => {
    const kysely = await pre0026Db();
    try {
      await dropNodePlugins.up(kysely);
      expect(await columns(kysely, "plugin_state")).toEqual(["plugin_id", "enabled", "updated_at"]);
    } finally {
      await kysely.destroy();
    }
  });

  it("defaults enabled to 1 and keys the table by plugin id", async () => {
    // The absent row is the default-enabled claim: installing writes nothing.
    const kysely = await freshDb();
    try {
      await dropNodePlugins.up(kysely);
      await sql`INSERT INTO plugin_state (plugin_id, updated_at) VALUES ('claude-code', '2026-09-10T00:00:00Z')`.execute(
        kysely,
      );
      const r = await sql<{
        enabled: number;
      }>`SELECT enabled FROM plugin_state WHERE plugin_id = 'claude-code'`.execute(kysely);
      expect(r.rows[0]?.enabled).toBe(1);
      // PK: a second row for the same plugin is a hard error, not a shadow.
      await expect(
        sql`INSERT INTO plugin_state (plugin_id, enabled, updated_at) VALUES ('claude-code', 0, 'x')`.execute(kysely),
      ).rejects.toThrow();
    } finally {
      await kysely.destroy();
    }
  });

  it("runs twice without failing", async () => {
    // Both halves idempotent (`ifNotExists` on the create, a
    // `pragma_table_info` guard on the drops): a dev database that applied
    // the file under its old name re-runs the extended version at boot
    // without hard-stopping.
    const kysely = await pre0026Db();
    try {
      await dropNodePlugins.up(kysely);
      await dropNodePlugins.up(kysely);
      expect(await columns(kysely, "nodes")).not.toContain("plugins_json");
      expect(await hasTable(kysely, "plugin_state")).toBe(true);
    } finally {
      await kysely.destroy();
    }
  });

  it("down recreates the mirror columns EMPTY and drops plugin_state", async () => {
    const kysely = await pre0026Db();
    try {
      await sql`INSERT INTO nodes (id, owner_user_id, name, kind, created_at, updated_at)
        VALUES ('n1', 'u1', 'box', 'agent', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z')`.execute(kysely);
      await dropNodePlugins.up(kysely);
      await dropNodePlugins.down(kysely);

      const after = await columns(kysely, "nodes");
      expect(after).toContain("plugins_json");
      expect(after).toContain("plugins_at");
      expect(await hasTable(kysely, "plugin_state")).toBe(false);
      // Empty by necessity: the mirror held what each node reported, and the
      // reporting is gone from the protocol — a downgrade cannot rebuild it
      // (0025's reasoning, same shape). The surviving row has NULLs, not a
      // fabricated report.
      // Aliased: the CamelCasePlugin rewrites bare `plugins_json` result keys
      // to camelCase, which would hide a non-null value behind `undefined`.
      const r = await sql<{ pj: string | null }>`SELECT plugins_json AS pj FROM nodes WHERE id = 'n1'`.execute(kysely);
      expect(r.rows[0]?.pj).toBeNull();
    } finally {
      await kysely.destroy();
    }
  });
});

describe("boot migration (the static provider map)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("lands on the post-0026 schema through the real migrate.ts map", async () => {
    // The map key must name a file that exists and whose `up` has run — this
    // is the check that the 0026 rename kept the two in step.
    const nodes = await columns(db, "nodes");
    expect(nodes).not.toContain("plugins_json");
    expect(nodes).not.toContain("plugins_at");
    expect(await columns(db, "plugin_state")).toEqual(["plugin_id", "enabled", "updated_at"]);
  });
});
