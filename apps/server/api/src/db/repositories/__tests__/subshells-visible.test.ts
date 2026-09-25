import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import * as initMigration from "@/db/migrations/0001-init.js";
import * as remoteOpsMigration from "@/db/migrations/0003-remote-ops.js";
import * as notifyMigration from "@/db/migrations/0014-session-notifications.js";
import * as sharingMigration from "@/db/migrations/0016-session-sharing.js";
import * as nodesMigration from "@/db/migrations/0017-nodes.js";
import * as subshellRenameMigration from "@/db/migrations/0019-subshell-rename.js";
import * as presetsMigration from "@/db/migrations/0027-presets.js";
import * as crossAgentMigration from "@/db/migrations/0039-subshell-cross-agent.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository, summarizeSubshells } from "@/db/repositories/subshells.repository.js";
import type { Database } from "@/db/types/index.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
import {
  attachConnection,
  detachConnection,
  isNodeOffline,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";

/**
 * Visibility is the WHERE-clause half of the sharing feature; it must be
 * pinned independently of the resolver (subshell-access) and the service. The
 * scratch DB (init + 0003 + 0014 + 0016 + 0017) gives `subshells` (with
 * alive/waiting_since/node_id), `subshell_shares` and `nodes` without relying
 * on another suite having migrated the shared test database.
 */
async function freshDb(): Promise<Kysely<Database>> {
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: async () => openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  await initMigration.up(db as Kysely<any>);
  await remoteOpsMigration.up(db as Kysely<any>);
  await notifyMigration.up(db as Kysely<any>);
  await sharingMigration.up(db as Kysely<any>);
  await nodesMigration.up(db as Kysely<any>);
  await subshellRenameMigration.up(db as Kysely<any>); // renamed schema the code sees
  await presetsMigration.up(db as Kysely<any>); // profiles → presets (spec 2026-09-13 §6)
  await crossAgentMigration.up(db as Kysely<any>); // subshells.cross_agent — SubshellsRepository.create writes it (2026-09-25)
  return db;
}

async function seed(
  db: Kysely<Database>,
  id: string,
  userId: string,
  status = "running",
  extra: { nodeId?: string; waitingSince?: string | null; alive?: number } = {},
) {
  await (db as Kysely<any>)
    .insertInto("subshells")
    .values({
      id,
      userId,
      presetId: "p",
      harnessId: "h",
      name: id,
      workingDir: "/tmp",
      tmuxSocket: null,
      status,
      ...(extra.nodeId !== undefined && { nodeId: extra.nodeId }),
      ...(extra.waitingSince !== undefined && { waitingSince: extra.waitingSince }),
      ...(extra.alive !== undefined && { alive: extra.alive }),
    })
    .execute();
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("SubshellsRepository.listVisibleTo", () => {
  it("a viewer sees own + Everyone-shared + named-shared, never a private foreign subshell", async () => {
    const db = await freshDb();
    await seed(db, "a_priv", "alice");
    await seed(db, "a_everyone", "alice");
    await seed(db, "a_bob", "alice");
    await seed(db, "c_priv", "carol");
    await seed(db, "b_own", "bob");
    const shares = new SubshellSharesRepository(db);
    await shares.replaceForSubshell("a_everyone", [{ granteeUserId: null, permission: "view" }], "alice");
    await shares.replaceForSubshell("a_bob", [{ granteeUserId: "bob", permission: "edit" }], "alice");

    const subshells = new SubshellsRepository(db);
    expect(ids(await subshells.listVisibleTo("bob", false))).toEqual(["a_bob", "a_everyone", "b_own"]);
    expect(ids(await subshells.listVisibleTo("alice", false))).toEqual(["a_bob", "a_everyone", "a_priv"]);
    // carol is in no grant except Everyone → she sees her own + the Everyone row only.
    expect(ids(await subshells.listVisibleTo("carol", false))).toEqual(["a_everyone", "c_priv"]);
    await db.destroy();
  });

  it("an admin sees every subshell regardless of ownership or grants", async () => {
    const db = await freshDb();
    await seed(db, "a_priv", "alice");
    await seed(db, "c_priv", "carol");
    await seed(db, "b_own", "bob");
    const subshells = new SubshellsRepository(db);
    expect(ids(await subshells.listVisibleTo("root", true))).toEqual(["a_priv", "b_own", "c_priv"]);
    await db.destroy();
  });

  it("the status filter narrows the visible set", async () => {
    const db = await freshDb();
    await seed(db, "run", "bob", "running");
    await seed(db, "done", "bob", "terminated");
    await seed(db, "shared_run", "alice", "running");
    const shares = new SubshellSharesRepository(db);
    await shares.replaceForSubshell("shared_run", [{ granteeUserId: "bob", permission: "view" }], "alice");
    const subshells = new SubshellsRepository(db);
    expect(ids(await subshells.listVisibleTo("bob", false, "running"))).toEqual(["run", "shared_run"]);
    expect(ids(await subshells.listVisibleTo("bob", false, "terminated"))).toEqual(["done"]);
    await db.destroy();
  });
});

/**
 * F1: the `waiting` badge count excludes subshells whose agent node is
 * unreachable (spec §5.6). Only `waiting` changes — `running` and `total`
 * stay last-known-truth counts. The predicate is INJECTED (the repository
 * must never import the registry), so the unit cases drive it with lambdas;
 * the repo-level case below uses the REAL blessed `isNodeOffline` against the
 * live-connection registry seam to prove the wiring.
 */
describe("summarizeSubshells — node-liveness-aware waiting", () => {
  // Annotated with the row shape the summarizer reads (the same Pick the
  // repository uses) so `status` stays a SubshellStatus, not a widened string.
  const waitingRemote: Pick<SubshellTable, "status" | "alive" | "waitingSince" | "nodeId"> = {
    status: "running",
    alive: 1,
    waitingSince: "2026-09-01T00:00:00.000Z",
    nodeId: "node-1",
  };
  const waitingLocal = { ...waitingRemote, nodeId: LOCAL_NODE_ID };

  it("drops the waiting count for an offline-node row but keeps running/total", () => {
    expect(summarizeSubshells([waitingRemote], (nodeId) => nodeId === "node-1")).toEqual({
      total: 1,
      running: 1,
      waiting: 0,
    });
  });

  it("counts waiting for reachable-node rows (predicate false on their id)", () => {
    expect(summarizeSubshells([waitingRemote], () => false)).toEqual({ total: 1, running: 1, waiting: 1 });
    // Mixed set: only the offline node's waiting row is dropped.
    const mixed = summarizeSubshells(
      [waitingRemote, { ...waitingRemote, nodeId: "node-2" }],
      (nodeId) => nodeId === "node-1",
    );
    expect(mixed).toEqual({ total: 2, running: 2, waiting: 1 });
  });

  it("the default predicate counts as if EVERY node were reachable", () => {
    // Non-badge callers: a caller that passes nothing keeps the pre-F1 shape.
    // Badge surfaces MUST pass the blessed predicate (JSDoc contract).
    expect(summarizeSubshells([waitingRemote])).toEqual({ total: 1, running: 1, waiting: 1 });
  });

  it("the predicate is consulted with each waiting row's nodeId — and only for waiting rows", () => {
    const seen: string[] = [];
    const rows: (typeof waitingRemote)[] = [
      waitingRemote,
      { ...waitingRemote, nodeId: "node-b" },
      // waitingSince but not alive+running → never counted, never consulted.
      { status: "terminated", alive: 0, waitingSince: waitingRemote.waitingSince, nodeId: "node-c" },
    ];
    summarizeSubshells(rows, (nodeId) => {
      seen.push(nodeId);
      return false;
    });
    expect(seen.sort()).toEqual(["node-1", "node-b"]);
  });

  it("real isNodeOffline: local rows are never offline, agent rows are (empty registry)", () => {
    resetNodeRegistryForTests();
    expect(isNodeOffline(LOCAL_NODE_ID)).toBe(false);
    expect(isNodeOffline("node-1")).toBe(true);
    expect(summarizeSubshells([waitingLocal], isNodeOffline)).toEqual({ total: 1, running: 1, waiting: 1 });
    expect(summarizeSubshells([waitingRemote], isNodeOffline)).toEqual({ total: 1, running: 1, waiting: 0 });
  });
});

describe("subshells counts — blessed predicate through the registry seam", () => {
  it("countsByUser/countsVisibleTo flip a remote waiting row with the registry", async () => {
    const db = await freshDb();
    await seed(db, "r_wait", "bob", "running", { nodeId: "node-x", waitingSince: new Date().toISOString() });
    await seed(db, "l_wait", "bob", "running", { waitingSince: new Date().toISOString() });
    const subshells = new SubshellsRepository(db);
    const offlineExpected = { total: 2, running: 2, waiting: 1 }; // only the local row waits
    const onlineExpected = { total: 2, running: 2, waiting: 2 };
    try {
      // Registry empty → the REAL blessed predicate says node-x is offline.
      resetNodeRegistryForTests();
      expect(await subshells.countsByUser("bob", isNodeOffline)).toEqual(offlineExpected);
      expect(await subshells.countsVisibleTo("bob", false, isNodeOffline)).toEqual(offlineExpected);
      // Bring node-x live through the registry seam — no predicate stubbing.
      const ws = { send: () => {}, close: () => {} };
      attachConnection("node-x", ws);
      expect(await subshells.countsByUser("bob", isNodeOffline)).toEqual(onlineExpected);
      expect(await subshells.countsVisibleTo("bob", false, isNodeOffline)).toEqual(onlineExpected);
      detachConnection("node-x", ws);
    } finally {
      resetNodeRegistryForTests();
      await db.destroy();
    }
  });
});
