import { beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";

/**
 * The channels feature tables exist with the expected columns after
 * migrations run, and the per-channel post sequence is unique-enforced —
 * the cursor contract the whole read path depends on.
 */
describe("0009-channels migration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  for (const t of [
    "channels",
    "channel_members",
    "channel_posts",
    "channel_post_recipients",
    "channel_cursors",
    "identities",
  ]) {
    it(`table ${t} exists`, async () => {
      const r = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' AND name=${t}`.execute(
        db,
      );
      expect(r.rows.length).toBe(1);
    });
  }

  it("subshells gains api_key_id", async () => {
    const r = await sql<{ name: string }>`SELECT name FROM pragma_table_info('subshells')`.execute(db);
    expect(r.rows.map((x) => x.name)).toContain("api_key_id");
  });

  it("channel posts unique (channel_id, seq)", async () => {
    await db.deleteFrom("channels").execute();
    await db
      .insertInto("channels")
      .values({ id: "c1", name: "smoke", createdBy: "user:t", createdAt: new Date().toISOString() })
      .execute();
    await db
      .insertInto("channelPosts")
      .values({
        id: "p1",
        channelId: "c1",
        seq: 1,
        author: "user:t",
        envelope: "{}",
        createdAt: new Date().toISOString(),
      })
      .execute();
    await expect(
      db
        .insertInto("channelPosts")
        .values({
          id: "p2",
          channelId: "c1",
          seq: 1,
          author: "user:t",
          envelope: "{}",
          createdAt: new Date().toISOString(),
        })
        .execute(),
    ).rejects.toThrow();
    await db.deleteFrom("channels").execute(); // cascades posts
    const left = await db.selectFrom("channelPosts").selectAll().execute();
    expect(left.length).toBe(0);
  });
});
