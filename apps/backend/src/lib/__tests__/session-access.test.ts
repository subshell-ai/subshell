import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { SessionSharesRepository } from "@/db/repositories/session-shares.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { Database } from "@/db/types/index.js";
import { accessAtLeast, loadSessionAccess, resolveSessionAccess } from "@/lib/session-access.js";

describe("resolveSessionAccess (pure)", () => {
  it("the owner always resolves to owner, even with no shares and even if admin", () => {
    expect(resolveSessionAccess("alice", false, "alice", [])).toBe("owner");
    expect(resolveSessionAccess("alice", true, "alice", [])).toBe("owner");
  });

  it("an admin who is not the owner gets edit (effective access, spec)", () => {
    expect(resolveSessionAccess("root", true, "alice", [])).toBe("edit");
  });

  it("Everyone(view) only → view; Everyone(edit) → edit", () => {
    expect(resolveSessionAccess("bob", false, "alice", [{ granteeUserId: null, permission: "view" }])).toBe("view");
    expect(resolveSessionAccess("bob", false, "alice", [{ granteeUserId: null, permission: "edit" }])).toBe("edit");
  });

  it("the highest of Everyone + a specific grant wins", () => {
    // Specific edit over Everyone view.
    expect(
      resolveSessionAccess("bob", false, "alice", [
        { granteeUserId: null, permission: "view" },
        { granteeUserId: "bob", permission: "edit" },
      ]),
    ).toBe("edit");
    // Everyone edit over a specific view.
    expect(
      resolveSessionAccess("bob", false, "alice", [
        { granteeUserId: null, permission: "edit" },
        { granteeUserId: "bob", permission: "view" },
      ]),
    ).toBe("edit");
  });

  it("a grant naming someone else does not leak to the viewer", () => {
    expect(resolveSessionAccess("bob", false, "alice", [{ granteeUserId: "carol", permission: "edit" }])).toBe("none");
  });

  it("no shares, not owner, not admin → none", () => {
    expect(resolveSessionAccess("bob", false, "alice", [])).toBe("none");
  });
});

describe("accessAtLeast", () => {
  it("ranks owner > edit > view > none", () => {
    expect(accessAtLeast("owner", "view")).toBe(true);
    expect(accessAtLeast("owner", "owner")).toBe(true);
    expect(accessAtLeast("edit", "view")).toBe(true);
    expect(accessAtLeast("edit", "edit")).toBe(true);
    expect(accessAtLeast("edit", "owner")).toBe(false);
    expect(accessAtLeast("view", "edit")).toBe(false);
    expect(accessAtLeast("view", "view")).toBe(true);
    expect(accessAtLeast("none", "view")).toBe(false);
  });
});

describe("loadSessionAccess", () => {
  async function freshDb(): Promise<Kysely<Database>> {
    const db = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
      plugins: [new CamelCasePlugin()],
    });
    await initMigration.up(db as Kysely<any>);
    await sharingMigration.up(db as Kysely<any>);
    return db;
  }

  function deps(db: Kysely<Database>) {
    return {
      sessions: new SessionsRepository(db),
      shares: new SessionSharesRepository(db),
      userMeta: new UserMetaRepository(db),
    };
  }

  async function seedSession(db: Kysely<Database>, id: string, userId: string) {
    await (db as Kysely<any>)
      .insertInto("sessions")
      .values({ id, userId, profileId: "p", harnessId: "h", name: id, workingDir: "/tmp", tmuxSocket: null })
      .execute();
  }

  it("a missing session yields row undefined and access none", async () => {
    const db = await freshDb();
    const { row, access } = await loadSessionAccess(deps(db), "bob", "ghost");
    expect(row).toBeUndefined();
    expect(access).toBe("none");
    await db.destroy();
  });

  it("resolves owner, admin-edit, shared-view and none from real rows + roles", async () => {
    const db = await freshDb();
    await seedSession(db, "s1", "alice");
    await (db as Kysely<any>).insertInto("userMeta").values({ userId: "root", role: "admin" }).execute();
    await (db as Kysely<any>).insertInto("userMeta").values({ userId: "bob", role: "user" }).execute();

    expect((await loadSessionAccess(deps(db), "alice", "s1")).access).toBe("owner");
    expect((await loadSessionAccess(deps(db), "root", "s1")).access).toBe("edit");
    expect((await loadSessionAccess(deps(db), "bob", "s1")).access).toBe("none");

    await deps(db).shares.replaceForSession("s1", [{ granteeUserId: "bob", permission: "view" }], "alice");
    expect((await loadSessionAccess(deps(db), "bob", "s1")).access).toBe("view");
    await db.destroy();
  });
});
