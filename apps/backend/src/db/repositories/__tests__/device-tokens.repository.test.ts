import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as deviceTokensMigration from "@/db/migrations/0015-device-push-tokens.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { DeviceTokensRepository } from "@/db/repositories/device-tokens.repository.js";
import type { Database } from "@/db/types/index.js";

async function freshDb() {
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db as Kysely<any>);
  await deviceTokensMigration.up(db as Kysely<any>);
  return db;
}

describe("DeviceTokensRepository", () => {
  it("upsertForUser moves ownership when another user enrolls the same token", async () => {
    const db = await freshDb();
    const repo = new DeviceTokensRepository(db);
    await repo.upsertForUser("u1", "ExponentPushToken[aaa]", "ios");
    await repo.upsertForUser("u2", "ExponentPushToken[aaa]", "android");
    expect(await repo.listByUser("u1")).toEqual([]);
    const rows = await repo.listByUser("u2");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "u2", token: "ExponentPushToken[aaa]", platform: "android" });
    expect(rows[0]?.createdAt).toBe(rows[0]?.updatedAt); // fresh insert, not a merge
    await db.destroy();
  });

  it("keeps distinct tokens of the same user side by side", async () => {
    const db = await freshDb();
    const repo = new DeviceTokensRepository(db);
    await repo.upsertForUser("u1", "ExponentPushToken[one]", "ios");
    await repo.upsertForUser("u1", "ExponentPushToken[two]", "ios");
    expect((await repo.listByUser("u1")).map((r) => r.token).sort()).toEqual([
      "ExponentPushToken[one]",
      "ExponentPushToken[two]",
    ]);
    await db.destroy();
  });

  it("deleteForUser is scoped; deleteByToken is not; both are idempotent", async () => {
    const db = await freshDb();
    const repo = new DeviceTokensRepository(db);
    await repo.upsertForUser("u1", "ExponentPushToken[aaa]", "ios");
    await repo.deleteForUser("u2", "ExponentPushToken[aaa]"); // wrong owner: no-op
    expect(await repo.listByUser("u1")).toHaveLength(1);
    await repo.deleteForUser("u1", "ExponentPushToken[aaa]");
    await repo.deleteForUser("u1", "ExponentPushToken[aaa]"); // second call must not throw
    expect(await repo.listByUser("u1")).toHaveLength(0);
    await repo.deleteByToken("ExponentPushToken[nope]"); // unknown token: no-op
    await db.destroy();
  });
});
