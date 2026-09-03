import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { Database } from "@/db/types/index.js";
import { accessAtLeast, loadSubshellAccess, resolveSubshellAccess } from "@/lib/subshell-access.js";

describe("resolveSubshellAccess (pure)", () => {
  it("the owner always resolves to owner, even with no shares and even if admin", () => {
    expect(resolveSubshellAccess("alice", false, "alice", [])).toBe("owner");
    expect(resolveSubshellAccess("alice", true, "alice", [])).toBe("owner");
  });

  it("an admin who is not the owner gets edit (effective access, spec)", () => {
    expect(resolveSubshellAccess("root", true, "alice", [])).toBe("edit");
  });

  it("Everyone(view) only → view; Everyone(edit) → edit", () => {
    expect(resolveSubshellAccess("bob", false, "alice", [{ granteeUserId: null, permission: "view" }])).toBe("view");
    expect(resolveSubshellAccess("bob", false, "alice", [{ granteeUserId: null, permission: "edit" }])).toBe("edit");
  });

  it("the highest of Everyone + a specific grant wins", () => {
    // Specific edit over Everyone view.
    expect(
      resolveSubshellAccess("bob", false, "alice", [
        { granteeUserId: null, permission: "view" },
        { granteeUserId: "bob", permission: "edit" },
      ]),
    ).toBe("edit");
    // Everyone edit over a specific view.
    expect(
      resolveSubshellAccess("bob", false, "alice", [
        { granteeUserId: null, permission: "edit" },
        { granteeUserId: "bob", permission: "view" },
      ]),
    ).toBe("edit");
  });

  it("a grant naming someone else does not leak to the viewer", () => {
    expect(resolveSubshellAccess("bob", false, "alice", [{ granteeUserId: "carol", permission: "edit" }])).toBe("none");
  });

  it("no shares, not owner, not admin → none", () => {
    expect(resolveSubshellAccess("bob", false, "alice", [])).toBe("none");
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

describe("loadSubshellAccess", () => {
  async function freshDb(): Promise<Kysely<Database>> {
    const db = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
      plugins: [new CamelCasePlugin()],
    });
    await initMigration.up(db as Kysely<any>);
    await sharingMigration.up(db as Kysely<any>);
    await subshellRenameMigration.up(db as Kysely<any>); // renamed schema the code sees
    return db;
  }

  function deps(db: Kysely<Database>) {
    return {
      subshells: new SubshellsRepository(db),
      shares: new SubshellSharesRepository(db),
      userMeta: new UserMetaRepository(db),
    };
  }

  async function seedSubshell(db: Kysely<Database>, id: string, userId: string) {
    await (db as Kysely<any>)
      .insertInto("subshells")
      .values({ id, userId, profileId: "p", harnessId: "h", name: id, workingDir: "/tmp", tmuxSocket: null })
      .execute();
  }

  it("a missing subshell yields row undefined and access none", async () => {
    const db = await freshDb();
    const { row, access } = await loadSubshellAccess(deps(db), "bob", "ghost");
    expect(row).toBeUndefined();
    expect(access).toBe("none");
    await db.destroy();
  });

  it("resolves owner, admin-edit, shared-view and none from real rows + roles", async () => {
    const db = await freshDb();
    await seedSubshell(db, "s1", "alice");
    await (db as Kysely<any>).insertInto("userMeta").values({ userId: "root", role: "admin" }).execute();
    await (db as Kysely<any>).insertInto("userMeta").values({ userId: "bob", role: "user" }).execute();

    expect((await loadSubshellAccess(deps(db), "alice", "s1")).access).toBe("owner");
    expect((await loadSubshellAccess(deps(db), "root", "s1")).access).toBe("edit");
    expect((await loadSubshellAccess(deps(db), "bob", "s1")).access).toBe("none");

    await deps(db).shares.replaceForSubshell("s1", [{ granteeUserId: "bob", permission: "view" }], "alice");
    expect((await loadSubshellAccess(deps(db), "bob", "s1")).access).toBe("view");
    await db.destroy();
  });
});
