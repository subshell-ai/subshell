import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSshConfigPath } from "@internal/pane-runtime";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { runMigrations } from "@/db/migrate.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { SubshellsService } from "@/services/subshells.service.js";
import { getLogger } from "@/utils/logger.js";

/**
 * The LOCAL half of the ssh config cleanup (spec 2026-10-07 decision 4;
 * plan-2 handoff 2): the exit-report path removes
 * `<SUBSHELL_SERVER_DATA_DIR>/ssh/<id>` when the row is a LOCAL pane whose
 * snapshot column is set. Remote panes sweep on the agent (their own disk);
 * this host must NEVER sweep an agent row's directory name off its own disk.
 *
 * It fires even when the row is already retired — a terminate kills the pane,
 * the tmux `pane-died` hook races the retire, and whichever order they land
 * in, the config's removal must be a sure thing (that is what Task 9's e2e
 * asserts after terminate).
 */

const OWNER = "u-ssh-exit";
const subshellsRepo = new SubshellsRepository(getRequestlessContext().db);
const created: string[] = [];
let service: SubshellsService;

const localDir = (id: string): string => join(SUBSHELL_SERVER_DATA_DIR, "ssh", id);

async function seedPaneRow(over: {
  id: string;
  nodeId: string;
  ssh: string | null;
  status?: "running" | "terminated";
  alive?: number;
}): Promise<void> {
  created.push(over.id);
  await subshellsRepo.create({
    id: over.id,
    userId: OWNER,
    harnessId: "ssh",
    name: "ssh exit row",
    workingDir: tmpdir(),
    tmuxSocket: `subshell-${over.id.slice(0, 8)}`,
    status: over.status ?? "running",
    alive: over.alive ?? 1,
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

describe("the exit report sweeps the LOCAL ssh config dir", () => {
  it("a running local ssh pane's death removes <dataDir>/ssh/<id> best-effort", async () => {
    const id = crypto.randomUUID();
    await seedPaneRow({ id, nodeId: LOCAL_NODE_ID, ssh: '{"host":"example.test"}' });
    makeConfigDir(id);
    expect(existsSync(localDir(id))).toBe(true);
    await service.reportExit(id, 0);
    expect(existsSync(localDir(id))).toBe(false); // handoff 2: the DIR (dirname of the config path), not just the file
    const row = await subshellsRepo.findById(id);
    expect(row?.alive).toBe(0); // the manager's death transition ran as before
  });

  it("a row the terminate already retired still sweeps (the hook-vs-retire race is the e2e's case)", async () => {
    const id = crypto.randomUUID();
    await seedPaneRow({ id, nodeId: LOCAL_NODE_ID, ssh: '{"host":"example.test"}', status: "terminated", alive: 0 });
    makeConfigDir(id);
    await service.reportExit(id, null);
    expect(existsSync(localDir(id))).toBe(false);
  });

  it("an AGENT row sweeps nothing on this host — the node cleans its own disk", async () => {
    const id = crypto.randomUUID();
    await seedPaneRow({ id, nodeId: "node-remote-ssh", ssh: '{"host":"example.test"}' });
    makeConfigDir(id); // a directory with the same NAME must survive: it is not ours
    await service.reportExit(id, 1);
    expect(existsSync(localDir(id))).toBe(true);
    rmSync(localDir(id), { recursive: true, force: true });
  });

  it("a local row without a snapshot sweeps nothing (non-ssh panes have no config to clean)", async () => {
    const id = crypto.randomUUID();
    await seedPaneRow({ id, nodeId: LOCAL_NODE_ID, ssh: null });
    await expect(service.reportExit(id, 0)).resolves.toBeUndefined();
    expect(existsSync(localDir(id))).toBe(false);
  });

  it("an already-dead row's report still converges and the sweep is idempotent on a missing dir", async () => {
    const id = crypto.randomUUID();
    await seedPaneRow({ id, nodeId: LOCAL_NODE_ID, ssh: '{"host":"example.test"}' });
    // No dir made at all: the sweep must not throw on a missing path.
    await expect(service.reportExit(id, 0)).resolves.toBeUndefined();
    await expect(service.reportExit(id, 0)).resolves.toBeUndefined();
  });
});
