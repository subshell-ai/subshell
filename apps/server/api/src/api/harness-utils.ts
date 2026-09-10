import { getHarness, scanOne } from "@internal/pane-runtime";
import type { Static } from "elysia";
import type { HarnessInfoSchema } from "@/api/models.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { type AgentInventory, probeInstalledOnly, readAgentInventory } from "@/services/nodes/inventory.js";
import { enabledInstalledPlugins } from "@/services/nodes/local-plugins.js";

/**
 * Every harness plugin id the instance offers — installed and not explicitly
 * disabled. This is a picker/list question ("what harnesses exist here"), so
 * it reads the INSTANCE store, not the compiled-in registry: an installed
 * third-party plugin appears here and an uninstalled built-in does not.
 *
 * (The registry keeps its honest use as the offline-installable catalog:
 * `GET /api/setup/harnesses` renders `builtInHarnesses()`, because that is
 * what the wizard can install with no network. Neither registry read — the
 * merged `allHarnesses()` nor that catalog — is ever the answer to "what is
 * installed".)
 */
export async function getAllHarnessIds(): Promise<string[]> {
  return (await enabledInstalledPlugins())
    .filter((r) => !r.broken)
    .map((r) => r.id)
    .sort();
}

/**
 * Route error with an HTTP status; the global error handler maps `status` to
 * the response code (the same duck-typed shape the per-route `*Error` classes
 * carry — `SetupError`'s successor). Raised by every plugin-management path,
 * so they produce one wire shape.
 */
export class HarnessStateError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HarnessStateError";
    this.status = status;
  }
}

/**
 * Report one plugin with fresh detection: install state, version, the reason
 * a lookup failed and when it ran are probed per request (a re-check is just
 * another GET); whether THIS INSTANCE has the plugin comes from the caller,
 * which reads the instance store.
 *
 * The probe is {@link scanOne}, the SAME function that used to run on an
 * agent against its own filesystem, so a local row and an agent row cannot
 * disagree about what an entry means.
 */
export async function harnessInfo(id: string, installedHere: boolean): Promise<Static<typeof HarnessInfoSchema>> {
  const h = getHarness(id);
  if (!h) throw new HarnessStateError("Unknown harness", 404);
  const entry = await scanOne(h);
  return {
    id: h.id,
    name: h.name,
    binary: h.binaryName,
    description: h.description,
    icon: h.icon,
    installed: entry.installed,
    version: entry.version,
    reason: entry.reason,
    checkedAt: entry.checkedAt,
    installedHere,
    install: h.installHint,
  };
}

/**
 * The ONE usability rule, batch or narrowed (spec 2026-09-10 Task 9).
 *
 * A harness is usable on a node when **the instance has the plugin installed
 * and enabled** ∧ **that node's detection found its binary**. There is no
 * per-node plugin set to consult and no `node.kind` branch in the rule; the
 * only per-node input is WHERE the detection half comes from — a live probe
 * this process runs for `local`, the cached `detect` answer for an agent —
 * and the agent answer counts only while FRESH (≤ 10-min TTL). The gate is
 * strict and the informational view (`effectiveHarnessStates`) is not, and
 * that asymmetry is deliberate.
 *
 * `onlyId` narrows the local probe to one plugin (what `harnessUsable` wants
 * when it asks about one harness) without giving the single-item and batch
 * paths two spellings of the predicate — the duplication ledger 17b existed
 * to forbid.
 */
async function usableHarnessIdSet(nodeId: string, onlyId?: string): Promise<Set<string>> {
  const usable = new Set<string>();
  const installed = await enabledInstalledPlugins();
  const wanted = onlyId === undefined ? installed : installed.filter((r) => r.id === onlyId);
  if (wanted.length === 0) return usable;

  let inv: AgentInventory;
  if (nodeId === LOCAL_NODE_ID) {
    inv = await probeInstalledOnly(wanted);
  } else {
    const node = await new NodesRepository(db).findById(nodeId);
    if (!node) return usable; // unknown node: nothing is usable, never a crash
    inv = readAgentInventory(node);
  }
  for (const report of wanted) {
    // A plugin that will not load in the control-plane process is unusable
    // everywhere, fresh binaries notwithstanding.
    if (report.broken) continue;
    if (inv.fresh && inv.entries.get(report.id)?.installed === true) usable.add(report.id);
  }
  return usable;
}

/**
 * The subset of ids currently usable on `nodeId` (default: this machine — one
 * probe pass for the whole set, what the profile-list filter consumes). Every
 * node runs the same rule; see {@link usableHarnessIdSet}.
 */
export async function usableHarnessIds(nodeId: string = LOCAL_NODE_ID): Promise<Set<string>> {
  return await usableHarnessIdSet(nodeId);
}

/**
 * Usable for ONE (harness × node) pair — the launch gate at the call sites
 * (`subshells.service` create, `subshell-manager` auto-restart, profile
 * create). Delegates to the one batch rule so the picker and the gate cannot
 * disagree, with only this plugin's binary probed on the local path.
 */
export async function harnessUsable(id: string, nodeId: string = LOCAL_NODE_ID): Promise<boolean> {
  return (await usableHarnessIdSet(nodeId, id)).has(id);
}
