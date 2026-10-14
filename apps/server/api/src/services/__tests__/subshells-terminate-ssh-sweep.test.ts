import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSshConfigPath } from "@internal/pane-runtime";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { runMigrations } from "@/db/migrate.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { type RelayBroker, setRelayBrokerForTests } from "@/services/ssh-relay.service.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";
import { SubshellsService } from "@/services/subshells.service.js";
import { getLogger } from "@/utils/logger.js";

/**
 * The TERMINATE half of the ssh config sweep (spec 2026-10-07 decision 4; the
 * e2e spec-22 finding): terminate revokes the pane's token synchronously with
 * the kill, so the tmux `pane-died` hook's report can arrive 401 and its sweep
 * never runs. The terminate verb therefore sweeps itself, through the SAME
 * {@link sweepLocalSshDir} the exit report calls (one function, no drift) —
 * and so does the maintenance kill, {@link SubshellManagerService.terminateForMaintenance},
 * which reaches the same teardown through the manager (no REST verb involved)
 * and raced the identical way: a maintenance window used to leave every local
 * ssh config dir behind.
 *
 * The rows here carry no tmux socket: the manager's kill is skipped, which is
 * the point — the sweep is the killer's own act after the teardown, not the
 * pane's last breath.
 */

const OWNER = "u-ssh-term";
const subshellsRepo = new SubshellsRepository(getRequestlessContext().db);
const created: string[] = [];
let service: SubshellsService;

const localDir = (id: string): string => join(SUBSHELL_SERVER_DATA_DIR, "ssh", id);

async function seedPaneRow(over: { id: string; nodeId: string; ssh: string | null }): Promise<void> {
  created.push(over.id);
  await subshellsRepo.create({
    id: over.id,
    userId: OWNER,
    harnessId: "ssh",
    name: "ssh terminate row",
    workingDir: tmpdir(),
    tmuxSocket: null, // no pane to kill: the test isolates the verb's sweep step
    status: "running",
    alive: 1,
    nodeId: over.nodeId,
    ssh: over.ssh,
  });
}

function makeConfigDir(id: string): void {
  const dir = localDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(buildSshConfigPath(SUBSHELL_SERVER_DATA_DIR, id), "Host *\n");
}

beforeAll(async () => {
  await runMigrations();
  const ctx = getRequestlessContext();
  service = new SubshellsService({ db: ctx.db, log: getLogger(), repos: ctx.repos });
});

afterAll(async () => {
  for (const id of created) {
    rmSync(localDir(id), { recursive: true, force: true });
    await subshellsRepo.delete(id).catch(() => {});
  }
});

describe("the terminate verb sweeps the LOCAL ssh config dir", () => {
  it("terminating a local ssh row removes <dataDir>/ssh/<id> (the dying hook is not relied on)", async () => {
    const id = crypto.randomUUID();
    await seedPaneRow({ id, nodeId: LOCAL_NODE_ID, ssh: '{"host":"example.test"}' });
    makeConfigDir(id);
    expect(existsSync(localDir(id))).toBe(true);
    expect(await service.terminateSubshell(OWNER, id, "cookie")).toEqual({ ok: true });
    expect(existsSync(localDir(id))).toBe(false); // file AND dir: the sweep is an rm -rf
    const row = await subshellsRepo.findById(id);
    expect(row?.status).toBe("terminated"); // the ordinary terminate still ran
  });

  it("terminating a local ORDINARY row touches nothing ssh-shaped (the guard, not luck)", async () => {
    const id = crypto.randomUUID();
    await seedPaneRow({ id, nodeId: LOCAL_NODE_ID, ssh: null });
    makeConfigDir(id); // a dir with the pane's NAME but no snapshot column: not its to remove
    expect(await service.terminateSubshell(OWNER, id, "cookie")).toEqual({ ok: true });
    expect(existsSync(localDir(id))).toBe(true);
    rmSync(localDir(id), { recursive: true, force: true });
  });

  it("terminating an AGENT ssh row sweeps nothing on this host (the node cleans its own disk)", async () => {
    const id = crypto.randomUUID();
    await seedPaneRow({ id, nodeId: "node-remote-term", ssh: '{"host":"example.test"}' });
    makeConfigDir(id); // same NAME, not ours: the agent's watcher owns that disk
    expect(await service.terminateSubshell(OWNER, id, "cookie")).toEqual({ ok: true });
    expect(existsSync(localDir(id))).toBe(true);
    rmSync(localDir(id), { recursive: true, force: true });
  });

  it("(M2 §5.6 child-exit) terminate also cuts any relay session brokered for the pane", async () => {
    // The kill hand is the sure thing: a brokered B-side relay must die with
    // the pane even when the node's dying report never lands. The broker's
    // pane lookup no-ops rows that never relayed, so this witness fires for
    // every terminate.
    const cuts: string[] = [];
    const spy = {
      openRelay: async () => {
        throw new Error("unused");
      },
      routeRelayFrame: () => {},
      closeRelay: async () => false,
      closeUnauthorizedForNode: async () => 0,
      closeForPane: async (paneId: string, reason: string) => {
        cuts.push(`${paneId}:${reason}`);
        return 0;
      },
      refuseOverCap: async () => false,
      onNodeSocketClosed: async () => 0,
      activeRelayCount: () => 0,
      sessionInfo: () => null,
      reset: () => {},
    };
    setRelayBrokerForTests(spy as unknown as RelayBroker);
    try {
      const id = crypto.randomUUID();
      await seedPaneRow({ id, nodeId: "node-remote-term", ssh: '{"host":"example.test"}' });
      expect(await service.terminateSubshell(OWNER, id, "cookie")).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 0)); // the sweep is fire-and-forget
      expect(cuts).toEqual([`${id}:child-exit`]);
    } finally {
      setRelayBrokerForTests(null);
    }
  });
});

/**
 * The MAINTENANCE kill reaches the same teardown through the manager with no
 * REST verb in the loop (the maintenance window and lockdown both call
 * `terminateForMaintenance` per row), so the verb's sweep never runs for it.
 * Same harness as the verb cases above: no tmux socket, so the kill is
 * skipped and the sweep is the act under test.
 */
describe("the maintenance kill sweeps the LOCAL ssh config dir", () => {
  const manager = new SubshellManagerService({
    subshells: subshellsRepo,
    presets: new PresetsRepository(getRequestlessContext().db),
    audit: async () => {},
    notify: async () => {},
  });

  it("terminateForMaintenance on a local ssh row removes <dataDir>/ssh/<id>", async () => {
    const id = crypto.randomUUID();
    await seedPaneRow({ id, nodeId: LOCAL_NODE_ID, ssh: '{"host":"example.test"}' });
    makeConfigDir(id);
    expect(existsSync(localDir(id))).toBe(true);
    const row = await subshellsRepo.findById(id);
    if (!row) throw new Error("seeded row vanished"); // the arg type is the full row
    await manager.terminateForMaintenance(row);
    expect(existsSync(localDir(id))).toBe(false); // file AND dir: the sweep is an rm -rf
    const after = await subshellsRepo.findById(id);
    expect(after?.status).toBe("terminated"); // the ordinary terminate still ran
  });

  it("terminateForMaintenance on an AGENT ssh row sweeps nothing on this host", async () => {
    const id = crypto.randomUUID();
    await seedPaneRow({ id, nodeId: "node-remote-maint", ssh: '{"host":"example.test"}' });
    makeConfigDir(id); // same NAME, not ours: the agent's watcher owns that disk
    const row = await subshellsRepo.findById(id);
    if (!row) throw new Error("seeded row vanished"); // the arg type is the full row
    await manager.terminateForMaintenance(row);
    expect(existsSync(localDir(id))).toBe(true);
    rmSync(localDir(id), { recursive: true, force: true });
  });
});
