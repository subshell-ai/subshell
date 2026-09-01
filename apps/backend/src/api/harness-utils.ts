import { ALL_HARNESSES, getHarness, type HarnessPlugin } from "@internal/harnesses";
import type { Static } from "elysia";
import type { HarnessInfoSchema } from "@/api/models.js";
import { db } from "@/db/index.js";
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";
import { NodeHarnessesRepository } from "@/db/repositories/node-harnesses.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { LOCAL_NODE_ID, type NodeTable } from "@/db/types/nodes.db-types.js";
import { ensureDefaultProfilesForHarness } from "@/services/default-profiles.js";
import { agentInventoryInstalled, readAgentInventory } from "@/services/nodes/inventory.js";
import { logger } from "@/utils/logger.js";

/** All known harness plugin ids. */
export function getAllHarnessIds(): string[] {
  return ALL_HARNESSES.map((h) => h.id);
}

/**
 * Enabled state for every registered plugin, from the lazily-written
 * `harnessPlugins` rows (absent row => the plugin's own default).
 */
export async function harnessEnabledStates(): Promise<Map<string, boolean>> {
  const ids = getAllHarnessIds();
  const repo = new HarnessPluginsRepository(db);
  return await repo.getEnabledStates(ids);
}

/**
 * Route error with an HTTP status; the global error handler maps `status` to
 * the response code (the same duck-typed shape the per-route `*Error` classes
 * carry — `SetupError`'s successor). Raised by the shared local-harness
 * toggle and the agent-node enable gate so both PATCH paths produce the same
 * wire shape.
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
 * Report one plugin with fresh detection: install state and version are
 * probed per request (a re-check is just another GET), enabled state comes
 * from the lazily-written `harnessPlugins` row.
 */
export async function harnessInfo(id: string, enabled: boolean): Promise<Static<typeof HarnessInfoSchema>> {
  const h = getHarness(id);
  if (!h) throw new HarnessStateError("Unknown harness", 404);
  const installed = await h.isInstalled();
  return {
    id: h.id,
    name: h.name,
    binary: h.binaryName,
    description: h.description,
    icon: h.icon,
    installed,
    version: installed ? ((await h.getVersion()) ?? undefined) : undefined,
    enabled,
    install: h.installHint,
  };
}

/**
 * The ONE local-harness toggle (spec 2026-08-31 §6.2): both
 * `PATCH /api/setup/harnesses/:id` and `PATCH /api/nodes/local/harnesses/:id`
 * call this, so `harness_plugins` stays the single authoritative store for
 * the control-plane host and the two paths can never drift.
 *
 * Semantics preserved from the setup route verbatim: enable re-runs the
 * install check (409 when the binary is missing), disable never checks, and
 * enabling best-effort seeds a "Default" profile per user (a seeding failure
 * must not undo the committed enable — the boot sweep heals it).
 *
 * Agent nodes do NOT go through here — their state lives in `node_harnesses`
 * (see `patch-node-harness.route.ts`).
 * @param harnessId - harness plugin id
 * @param enabled - the new state
 * @returns the fresh plugin info for the response body
 */
export async function toggleLocalHarness(
  harnessId: string,
  enabled: boolean,
): Promise<Static<typeof HarnessInfoSchema>> {
  const h = getHarness(harnessId);
  if (!h) throw new HarnessStateError("Unknown harness", 404);
  if (enabled && !(await h.isInstalled())) {
    // Turning a harness on re-runs detection: the "I just installed it, make
    // it usable" flow is exactly this toggle, with no separate check step to
    // invent. Disabling never needs a check.
    throw new HarnessStateError(`"${h.name}" is not installed on this machine`, 409);
  }
  await new HarnessPluginsRepository(db).setEnabled(h.id, enabled);
  if (enabled) {
    // Enabling a harness makes it usable for everyone, so guarantee each user
    // has a Default profile for it (insert-only when they have none).
    // BEST-EFFORT: the enable itself already committed, so a seeding failure
    // must not 500 (and flip the client's switch back) over an optional
    // convenience — the boot sweep heals it; log so it is diagnosable.
    await ensureDefaultProfilesForHarness(db, h.id).catch((err: unknown) => {
      logger.withError(err).warn(`default-profile seeding failed on enabling harness ${h.id}`);
    });
  }
  return await harnessInfo(h.id, enabled);
}

/**
 * Usable = the plugin exists, is enabled, AND its binary is installed. The
 * install check is load-bearing here, matching the product rule "if it isn't
 * installed it stays unavailable": a missing binary hides the harness's
 * profiles and blocks new sessions even when the enabled flag defaults on.
 *
 * Node-aware (spec 2026-08-31 §6.2): with no `nodeId` (or `"local"`) this is
 * the process-local probe, verbatim — every existing zero-arg caller keeps
 * today's behavior. For an AGENT node it is the strict LAUNCH gate:
 * per-node enabled state (lazy `node_harnesses` row, else the plugin
 * default) ∧ a FRESH (≤ 10-min TTL) cached inventory that says installed.
 * Stale or never-reported inventory ⇒ NOT usable for launch, even though the
 * informational view (`services/nodes/inventory.ts` →
 * `effectiveHarnessStates`) still shows the last-reported values — gate and
 * view are deliberately separate strictnesses.
 */
export async function harnessUsable(id: string, nodeId: string = LOCAL_NODE_ID): Promise<boolean> {
  const plugin = getHarness(id);
  if (!plugin) return false;
  if (nodeId !== LOCAL_NODE_ID) {
    const node = await new NodesRepository(db).findById(nodeId);
    if (!node) return false;
    // A local-kind row (defensively: only the seeded host is `local`) always
    // resolves through the instance store, never an inventory.
    if (node.kind !== "local") return agentHarnessUsable(node, plugin);
  }
  const states = await harnessEnabledStates();
  if (!(states.get(id) ?? plugin.enabledByDefault)) return false;
  return await plugin.isInstalled();
}

/**
 * The agent-branch rule for one resolved node row: per-node enabled lazy row
 * (else the plugin default) ∧ the strict fresh-inventory check. The single
 * home of that rule, shared by {@link harnessUsable} and
 * {@link usableHarnessIds}.
 */
async function agentHarnessUsable(node: NodeTable, plugin: HarnessPlugin): Promise<boolean> {
  const states = await new NodeHarnessesRepository(db).enabledStates(node.id);
  if (!(states.get(plugin.id) ?? plugin.enabledByDefault)) return false;
  return agentInventoryInstalled(node, plugin.id);
}

/**
 * The subset of ids that are currently usable on `nodeId` (default: this
 * machine — one install probe per harness, batched for the profile-list
 * filter). Agent nodes compute the same rule as {@link agentHarnessUsable},
 * with the rows and the inventory parsed once for the whole batch.
 */
export async function usableHarnessIds(nodeId: string = LOCAL_NODE_ID): Promise<Set<string>> {
  const usable = new Set<string>();

  let node: NodeTable | undefined;
  if (nodeId !== LOCAL_NODE_ID) {
    node = await new NodesRepository(db).findById(nodeId);
    if (!node) return usable;
  }

  if (node && node.kind === "agent") {
    const nodeStates = await new NodeHarnessesRepository(db).enabledStates(node.id);
    const inv = readAgentInventory(node);
    for (const h of ALL_HARNESSES) {
      if ((nodeStates.get(h.id) ?? h.enabledByDefault) && inv.fresh && inv.entries.get(h.id)?.installed === true) {
        usable.add(h.id);
      }
    }
    return usable;
  }

  const states = await harnessEnabledStates();
  for (const h of ALL_HARNESSES) {
    if ((states.get(h.id) ?? h.enabledByDefault) && (await h.isInstalled())) usable.add(h.id);
  }
  return usable;
}
