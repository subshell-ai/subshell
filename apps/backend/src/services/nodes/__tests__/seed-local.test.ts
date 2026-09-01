import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ensureSystemUser } from "@/auth/system-user.js";
import { runAuthMigrations } from "@/db/auth-migrations.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js"; // no-op when already applied
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalNode } from "../seed-local.js";

/**
 * `ensureLocalNode` boot seeding (spec 2026-08-31 §2).
 *
 * Every file in one `bun test` invocation shares the temp DB, and
 * `nodes.repository.test.ts` also writes the `local` row (as a fixture with a
 * synthetic owner) — so each test here WIPES the local row + its shares before
 * acting instead of assuming anything about what a previous suite left behind.
 */

// Salted unique ids (same pattern as nodes.repository.test.ts): the bare
// pid+seq would collide across files because seq restarts at 0 per file.
const salt = Math.random().toString(36).slice(2, 8);
let seq = 0;
const unique = (p: string) => `${p}-${process.pid}-${salt}-${seq++}`;

const nodes = new NodesRepository(db);
const shares = new NodeSharesRepository(db);

async function wipeLocal(): Promise<void> {
  await db.deleteFrom("nodeShares").where("nodeId", "=", LOCAL_NODE_ID).execute();
  await db.deleteFrom("nodes").where("id", "=", LOCAL_NODE_ID).execute();
}

beforeAll(async () => {
  // Production boot order (see src/index.ts): app tables, then better-auth's —
  // `ensureSystemUser` INSERTs into better-auth's own `user` table.
  await runMigrations();
  await runAuthMigrations();
});

// The tests here MUTATE the shared `local` row (wipe, rename, os edits) — wipe
// it on the way out too, so a later suite in the same `bun test` invocation
// doesn't inherit a "Renamed"/plan9 local node from this file.
afterAll(wipeLocal);

describe("ensureLocalNode", () => {
  it("seeds exactly one local row + one Everyone/edit share, and a double run changes nothing", async () => {
    await wipeLocal();
    const systemId = await ensureSystemUser();

    await ensureLocalNode(db);
    await ensureLocalNode(db); // idempotent — never throws for "already seeded"

    const rows = await db.selectFrom("nodes").selectAll().where("id", "=", LOCAL_NODE_ID).execute();
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.kind).toBe("local");
    expect(row?.ownerUserId).toBe(systemId);
    expect(row?.name).toBe("Local");
    expect(row?.status).toBe("online");
    expect(row?.os).toBe(process.platform === "darwin" ? "darwin" : "linux");
    expect(row?.arch).toBe(process.arch);
    expect(typeof row?.hostname).toBe("string");
    expect((row?.hostname ?? "").length).toBeGreaterThan(0);

    const grants = await shares.listForNode(LOCAL_NODE_ID);
    expect(grants.length).toBe(1);
    expect(grants[0]?.granteeUserId).toBeNull();
    expect(grants[0]?.permission).toBe("edit");
    expect(grants[0]?.createdBy).toBe(systemId);
  });

  it("repair re-adds a deleted Everyone share WITHOUT clobbering a named grant", async () => {
    await wipeLocal();
    await ensureLocalNode(db);
    const systemId = await ensureSystemUser();
    const grantee = unique("u");

    // An admin's named grant, then the Everyone row deleted (the state a boot
    // repair must recover from).
    await db
      .insertInto("nodeShares")
      .values({
        id: unique("sh"),
        nodeId: LOCAL_NODE_ID,
        granteeUserId: grantee,
        permission: "view",
        createdBy: systemId,
        createdAt: new Date().toISOString(),
      })
      .execute();
    await db.deleteFrom("nodeShares").where("nodeId", "=", LOCAL_NODE_ID).where("granteeUserId", "is", null).execute();

    await ensureLocalNode(db);

    const grants = await shares.listForNode(LOCAL_NODE_ID);
    expect(grants.length).toBe(2); // repair APPENDS the missing Everyone row
    const everyone = grants.find((s) => s.granteeUserId === null);
    expect(everyone?.permission).toBe("edit");
    expect(everyone?.createdBy).toBe(systemId);
    const named = grants.find((s) => s.granteeUserId === grantee);
    expect(named?.permission).toBe("view"); // survives the replace-merge
  });

  it("an existing local row is never overwritten (rename/os edits survive a re-run)", async () => {
    await wipeLocal();
    await ensureLocalNode(db);

    // Someone edited the row (rename is the supported edit; the os pre-seed is
    // the brief's "different os" probe).
    await db.updateTable("nodes").set({ name: "Renamed", os: "plan9" }).where("id", "=", LOCAL_NODE_ID).execute();

    await ensureLocalNode(db);

    const row = await nodes.findById(LOCAL_NODE_ID);
    expect(row?.name).toBe("Renamed"); // seed only fills absence
    expect(row?.os).toBe("plan9");
    // …and the share guarantee still holds
    const grants = await shares.listForNode(LOCAL_NODE_ID);
    expect(grants.some((s) => s.granteeUserId === null && s.permission === "edit")).toBe(true);
  });
});
