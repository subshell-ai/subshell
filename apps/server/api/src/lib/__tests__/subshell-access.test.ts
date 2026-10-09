import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as presetsMigration from "@/db/migrations/0027-presets.js";
import * as crossAgentMigration from "@/db/migrations/0039-subshell-cross-agent.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { Database } from "@/db/types/index.js";
import { accessAtLeast, loadSubshellAccess, resolveSubshellAccess } from "@/lib/subshell-access.js";

describe("resolveSubshellAccess (pure)", () => {
  it("the owner always resolves to owner, even with no shares", () => {
    expect(resolveSubshellAccess("alice", "alice", [])).toBe("owner");
  });

  it("the resolver cannot see the admin role: it takes no role input at all", () => {
    // Operator ruling 2026-10-09: the admin role carries no subshell reach.
    // Arity is the pin - a reintroduced admin arm needs a signature change
    // this test refuses (the loadSubshellAccess section below runs the DB
    // half: a stored role='admin' row resolves like a stranger's).
    expect(resolveSubshellAccess.length).toBe(3);
  });

  it("Everyone(view) only → view; Everyone(edit) → edit", () => {
    expect(resolveSubshellAccess("bob", "alice", [{ granteeUserId: null, permission: "view" }])).toBe("view");
    expect(resolveSubshellAccess("bob", "alice", [{ granteeUserId: null, permission: "edit" }])).toBe("edit");
  });

  it("the highest of Everyone + a specific grant wins", () => {
    // Specific edit over Everyone view.
    expect(
      resolveSubshellAccess("bob", "alice", [
        { granteeUserId: null, permission: "view" },
        { granteeUserId: "bob", permission: "edit" },
      ]),
    ).toBe("edit");
    // Everyone edit over a specific view.
    expect(
      resolveSubshellAccess("bob", "alice", [
        { granteeUserId: null, permission: "edit" },
        { granteeUserId: "bob", permission: "view" },
      ]),
    ).toBe("edit");
  });

  it("a grant naming someone else does not leak to the viewer", () => {
    expect(resolveSubshellAccess("bob", "alice", [{ granteeUserId: "carol", permission: "edit" }])).toBe("none");
  });

  it("no shares, not owner → none", () => {
    expect(resolveSubshellAccess("bob", "alice", [])).toBe("none");
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
    await presetsMigration.up(db as Kysely<any>); // profiles → presets (spec 2026-09-13 §6)
    await crossAgentMigration.up(db as Kysely<any>); // subshells.cross_agent — repo create writes it (2026-09-25)
    return db;
  }

  function deps(db: Kysely<Database>) {
    return {
      subshells: new SubshellsRepository(db),
      shares: new SubshellSharesRepository(db),
    };
  }

  async function seedSubshell(db: Kysely<Database>, id: string, userId: string) {
    await (db as Kysely<any>)
      .insertInto("subshells")
      .values({ id, userId, presetId: "p", harnessId: "h", name: id, workingDir: "/tmp", tmuxSocket: null })
      .execute();
  }

  it("a missing subshell yields row undefined and access none", async () => {
    const db = await freshDb();
    const { row, access } = await loadSubshellAccess(deps(db), "bob", "ghost");
    expect(row).toBeUndefined();
    expect(access).toBe("none");
    await db.destroy();
  });

  it("resolves owner, shared-view and none - and an ADMIN row resolves as a stranger's (2026-10-09)", async () => {
    const db = await freshDb();
    await seedSubshell(db, "s1", "alice");
    await (db as Kysely<any>).insertInto("userMeta").values({ userId: "root", role: "admin" }).execute();
    await (db as Kysely<any>).insertInto("userMeta").values({ userId: "bob", role: "user" }).execute();

    expect((await loadSubshellAccess(deps(db), "alice", "s1")).access).toBe("owner");
    // The role is REAL in this DB (the row exists, role='admin') and buys
    // nothing here: foreign pane, no grant ⇒ none, exactly bob's answer.
    expect((await loadSubshellAccess(deps(db), "root", "s1")).access).toBe("none");
    expect((await loadSubshellAccess(deps(db), "bob", "s1")).access).toBe("none");

    // A grant reaches an admin like it reaches anyone: same permission, no
    // boost on top of it.
    await deps(db).shares.replaceForSubshell("s1", [{ granteeUserId: "root", permission: "view" }], "alice");
    expect((await loadSubshellAccess(deps(db), "root", "s1")).access).toBe("view");
    await db.destroy();
  });
});
