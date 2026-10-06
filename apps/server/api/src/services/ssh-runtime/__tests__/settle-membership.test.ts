import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { NODE_KIND_RUNTIME } from "@/db/types/nodes.db-types.js";
import * as liveBus from "@/services/live-bus.js";
import * as subshellTokens from "@/services/subshell-tokens.js";
import { mkRuntimeSession } from "@/test-helpers/runtime-session.js";
import { sessionHooks } from "../session-registry.js";
import { installSessionSettlers } from "../session-settle.js";

/**
 * The I4 membership guard (review 2026-10-06, design §8: remote output is
 * untrusted): `onPaneExit`/`onReport` write the DB and revoke tokens for
 * every id the runtime names, so an id naming a pane OUTSIDE the session -
 * another session's pane, an agent node's row - must be SKIPPED entirely:
 * no row flip, no revoke, no live-bus publish. The settle-all paths already
 * iterate `session.paneIds()`; these two consume frame data directly, and
 * this file is the whole point of the guard. Genuine members still settle.
 *
 * The revoke + publish seams are captured through the module namespaces
 * (the settle's imports are live bindings; bun rewrites them on
 * `mock.module`); the row truth is read straight from the test DB.
 */

const email = `settlemem-${crypto.randomUUID()}@subshell.local`;
let userId: string;
const revokes: string[] = [];
const publishes: string[] = [];
const cleanup: string[] = [];

const subshellsRepo = new SubshellsRepository(db);

const OWN = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";

async function mkRow(id: string, nodeId: string): Promise<void> {
  cleanup.push(id);
  await subshellsRepo.create({
    id,
    userId,
    harnessId: "claude-code",
    name: `sm-${id.slice(0, 4)}`,
    workingDir: "/tmp",
    nodeId,
    tmuxSocket: `sock-${id}`,
    status: "running",
    alive: 1,
  });
}

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("sm-pass-1"),
    role: "user",
  });
  // Capture the settle's two side-door seams BEFORE any session exists.
  const originalRevoke = subshellTokens.revokeSubshellToken;
  const originalPublish = liveBus.publishLive;
  mock.module("@/services/subshell-tokens.js", () => ({
    ...subshellTokens,
    revokeSubshellToken: async (id: string) => {
      revokes.push(id);
      return originalRevoke(id);
    },
  }));
  mock.module("@/services/live-bus.js", () => ({
    ...liveBus,
    publishLive: (frame: { kind: string; id?: string }) => {
      if (typeof frame.id === "string") publishes.push(frame.id);
      return originalPublish(frame as never);
    },
  }));
  installSessionSettlers();
  await seedNodesAndRows();
});

afterAll(async () => {
  for (const id of cleanup) await subshellsRepo.delete(id).catch(() => {});
  await deleteUserByEmailOrId(email).catch(() => {});
});

/** One hidden runtime node per role, seeded once (the rows have fixed ids). */
let ownRuntimeNodeId = "";
let foreignRuntimeNodeId = "";

async function seedNodesAndRows(): Promise<void> {
  ownRuntimeNodeId = crypto.randomUUID();
  foreignRuntimeNodeId = crypto.randomUUID();
  cleanup.push(ownRuntimeNodeId, foreignRuntimeNodeId);
  const nodes = new NodesRepository(db);
  for (const id of [ownRuntimeNodeId, foreignRuntimeNodeId]) {
    await nodes.create({
      id,
      ownerUserId: userId,
      name: `sm-rt-${id.slice(0, 8)}`,
      kind: NODE_KIND_RUNTIME,
      status: "online",
      lastSeenAt: new Date().toISOString(),
    });
  }
  await mkRow(OWN, ownRuntimeNodeId);
  await mkRow(FOREIGN, foreignRuntimeNodeId);
}

/** Fresh alive rows for both panes before every test (the settles write them down). */
beforeEach(async () => {
  revokes.length = 0;
  publishes.length = 0;
  await subshellsRepo.update(OWN, { alive: 1, exitCode: null });
  await subshellsRepo.update(FOREIGN, { alive: 1, exitCode: null });
});

/** A live session owning exactly `OWN`, on the pre-seeded rows. */
function fixture(): ReturnType<typeof mkRuntimeSession> {
  const session = mkRuntimeSession({ ownerId: userId, runtimeNodeId: ownRuntimeNodeId });
  session.hooks = sessionHooks();
  session.registerPane(OWN, "subshell_pane_plaintext");
  return session;
}

describe("settle membership (I4): reported ids touch only this session's panes", () => {
  test("onReport with a foreign id: no row flip, no revoke, no publish; the member row still settles", async () => {
    revokes.length = 0;
    publishes.length = 0;
    const session = fixture();
    // The census a lying (or merely confused) runtime might answer: the own
    // pane dead, a FOREIGN valid id reported dead with it.
    session.hooks.onReport(session, [
      { subshellId: OWN, alive: false, exitCode: 7 },
      { subshellId: FOREIGN, alive: false, exitCode: 3 },
    ]);
    await new Promise((r) => setTimeout(r, 50)); // the settle's void DB writes
    const own = await subshellsRepo.findById(OWN);
    const foreign = await subshellsRepo.findById(FOREIGN);
    expect(own?.alive).toBe(0); // the member settled exactly as before
    expect(own?.exitCode).toBe(7);
    expect(foreign?.alive, "a foreign row must read untouched").toBe(1);
    expect(foreign?.exitCode, "no invented exit code").toBeNull();
    expect(revokes).toEqual([OWN]);
    expect(publishes).toEqual([OWN]);
    expect(session.paneIds()).toEqual([]); // only the member was unregistered
  });

  test("onPaneExit with a foreign id is skipped; a member exit still settles", async () => {
    revokes.length = 0;
    publishes.length = 0;
    const session = fixture();
    session.hooks.onPaneExit(session, FOREIGN, 9, new Date().toISOString());
    await new Promise((r) => setTimeout(r, 50));
    expect((await subshellsRepo.findById(FOREIGN))?.alive).toBe(1);
    expect(revokes).toEqual([]);
    expect(publishes).toEqual([]);

    session.hooks.onPaneExit(session, OWN, 0, new Date().toISOString());
    await new Promise((r) => setTimeout(r, 50));
    expect((await subshellsRepo.findById(OWN))?.alive).toBe(0);
    expect(revokes).toEqual([OWN]);
    expect(publishes).toEqual([OWN]);
  });

  test("an id with NO row at all is skipped too (the census cannot mint liveness)", async () => {
    revokes.length = 0;
    publishes.length = 0;
    const session = fixture();
    session.hooks.onReport(session, [{ subshellId: FOREIGN, alive: true, exitCode: null }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(publishes).toEqual([]);
    expect(session.paneIds()).toEqual([OWN]); // membership intact, nothing touched
  });
});
