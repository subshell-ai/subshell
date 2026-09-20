import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as favoritesMigration from "@/db/migrations/0012-favorites.js";
import * as nodeScopeMigration from "@/db/migrations/0034-favorites-node-scope.js";
import { openSqliteDatabase } from "@/db/open-database.js";

/**
 * Focused coverage for migration 0034 — favorites gaining the node dimension
 * that `recent_paths` got in 0017. The schema step is the boot path's ordinary
 * one (every full-migration suite exercises it); what is tested here is the
 * `down()` collapse, the only step that MUTATES rows: the UNIQUE index it
 * re-creates spans (user, kind, ref), and a node-scoped world can hold one
 * path starred on two machines — a careless down would fail on the collision
 * or keep a machine's favorite under a schema that can no longer name the
 * machine.
 */

async function favoritesDb(): Promise<{ db: Kysely<any>; handle: Database }> {
  const handle = openSqliteDatabase(":memory:");
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: async () => handle }),
    plugins: [new CamelCasePlugin()],
  });
  // 0012's up creates `favorites` and its unique index; its bookmarks
  // backfill is guarded on the table existing and skips on a fresh schema.
  await favoritesMigration.up(db);
  return { db, handle };
}

function seed(handle: Database, rows: { id: string; ref: string; nodeId?: string; createdAt: string }[]): void {
  for (const r of rows) {
    handle.run(
      `INSERT INTO favorites (id, user_id, kind, ref, created_at${r.nodeId === undefined ? "" : ", node_id"})
       VALUES (?, 'u1', 'directory', ?, ?${r.nodeId === undefined ? "" : ", ?"})`,
      r.nodeId === undefined ? [r.id, r.ref, r.createdAt] : [r.id, r.ref, r.createdAt, r.nodeId],
    );
  }
}

function rowsOf(handle: Database): { id: string; ref: string; nodeId: string | null }[] {
  return handle.query("SELECT id, ref, node_id AS nodeId FROM favorites ORDER BY id").all() as unknown as {
    id: string;
    ref: string;
    nodeId: string | null;
  }[];
}

describe("migration 0034 favorites node scope", () => {
  it("up defaults existing rows to local and the node key allows the same path twice", async () => {
    const { db, handle } = await favoritesDb();
    seed(handle, [{ id: "old", ref: "/srv/kept", createdAt: "2026-01-01T00:00:00.000Z" }]);
    await nodeScopeMigration.up(db);
    expect(rowsOf(handle)).toEqual([{ id: "old", ref: "/srv/kept", nodeId: "local" }]);
    // The rebuilt unique key spans the node: one path, two machines, two rows.
    seed(handle, [
      { id: "loc", ref: "/home/dev/api", nodeId: "local", createdAt: "2026-02-01T00:00:00.000Z" },
      { id: "box", ref: "/home/dev/api", nodeId: "node-9", createdAt: "2026-02-02T00:00:00.000Z" },
    ]);
    expect(rowsOf(handle)).toHaveLength(3);
  });

  it("down drops node rows and keeps local ones, restoring the pre-0034 key", async () => {
    const { db, handle } = await favoritesDb();
    await nodeScopeMigration.up(db);
    // One path on two machines plus a node-only star. Local duplicates cannot
    // be seeded THROUGH the (user, node, kind, ref) unique key — the collapse
    // inside down() is the same defense 0017's down carries, not a reachable
    // state — so what this pins is the reachable half.
    seed(handle, [
      { id: "a", ref: "/dup", nodeId: "local", createdAt: "2026-03-01T00:00:00.000Z" },
      { id: "c", ref: "/only-on-box", nodeId: "node-9", createdAt: "2026-03-03T00:00:00.000Z" },
      { id: "d", ref: "/dup", nodeId: "node-9", createdAt: "2026-03-04T00:00:00.000Z" },
    ]);
    await nodeScopeMigration.down(db);
    // Non-local rows go entirely (a favorite of a machine the old schema can
    // no longer name); the local survivor stands untouched.
    const kept = handle.query("SELECT id, ref FROM favorites ORDER BY id").all();
    expect(kept).toEqual([{ id: "a", ref: "/dup" }]);
    // The column itself is gone, not merely unused…
    const cols = handle.query("PRAGMA table_info(favorites)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).not.toContain("node_id");
    // …and the pre-0034 unique index is back: a second local row for the
    // same path must collide again.
    expect(() => seed(handle, [{ id: "e", ref: "/dup", createdAt: "2026-03-05T00:00:00.000Z" }])).toThrow();
  });
});
