import { allHarnesses, getHarness, scanOne } from "@internal/pane-runtime";
import type { Static } from "elysia";
import type { HarnessInfoSchema } from "@/api/models.js";
import { db } from "@/db/index.js";
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { LOCAL_NODE_ID, type NodeTable } from "@/db/types/nodes.db-types.js";
import { ensureDefaultProfilesForHarness } from "@/services/default-profiles.js";
import {
  type AgentInventory,
  type NodePluginSet,
  readAgentInventory,
  readNodePlugins,
} from "@/services/nodes/inventory.js";
import { logger } from "@/utils/logger.js";

/** All known harness plugin ids. */
export function getAllHarnessIds(): string[] {
  return allHarnesses().map((h) => h.id);
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
 * Report one plugin with fresh detection: install state, version, the reason
 * a lookup failed and when it ran are probed per request (a re-check is just
 * another GET); enabled state comes from the lazily-written `harnessPlugins`
 * row.
 *
 * The probe is {@link scanOne}, the SAME function the node agent runs against
 * its own filesystem, so a local row and an agent row cannot disagree about
 * what an entry means. This used to be a second, hand-rolled implementation
 * here, which is how the server came to report neither a reason nor a
 * timestamp while the agent reported both, and how it came to walk the lookup
 * ladder twice per harness per request.
 */
export async function harnessInfo(id: string, enabled: boolean): Promise<Static<typeof HarnessInfoSchema>> {
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
    enabled,
    install: h.installHint,
  };
}

/**
 * The local-harness toggle, reached by `PATCH /api/setup/harnesses/:id`.
 *
 * `harness_plugins` is the authoritative store for the control-plane host, and
 * this is the only writer. It used to have a second caller on the nodes routes
 * (`PATCH /api/nodes/local/harnesses/:id`), which is gone: what a node offers
 * is now what it has installed, and `local` is the one host whose set is still
 * a toggle rather than an install.
 *
 * Semantics preserved from the setup route verbatim: enable re-runs the
 * install check (409 when the binary is missing), disable never checks, and
 * enabling best-effort seeds a "Default" profile per user (a seeding failure
 * must not undo the committed enable — the boot sweep heals it).
 *
 * Agent nodes do NOT go through here, and no longer have an equivalent: what
 * a node offers is what it has INSTALLED, which the node itself owns
 * (`services/nodes/plugin-sync.ts`, spec 2026-09-09 §6). There is nothing to
 * toggle there.
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
 * profiles and blocks new subshells even when the enabled flag defaults on.
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
  if (nodeId !== LOCAL_NODE_ID) {
    const node = await new NodesRepository(db).findById(nodeId);
    if (!node) return false;
    // A local-kind row (defensively: only the seeded host is `local`) always
    // resolves through the instance store, never an inventory.
    //
    // The registry is deliberately NOT consulted first for an agent. A node
    // may offer a plugin this build has never heard of, which is the point of
    // the phase, and a `getHarness(id)` short-circuit here made this gate
    // disagree with {@link usableHarnessIds}: the picker offered such a plugin
    // and the launch then refused it with no explanation.
    if (node.kind !== "local") return agentHarnessUsableForNode(node, id);
  }
  const plugin = getHarness(id);
  if (!plugin) return false;
  const states = await harnessEnabledStates();
  if (!(states.get(id) ?? plugin.enabledByDefault)) return false;
  return await plugin.isInstalled();
}

/**
 * The ONE spelling of the agent-node launch gate for one (plugin × node)
 * pair (ledger 17b — dedups the rule previously spelled here AND in
 * {@link usableHarnessIds}): per-node enabled lazy row (else the plugin
 * default) ∧ a FRESH inventory that explicitly says installed. Pure — the
 * caller supplies the state map and the parsed inventory, so the batch path
 * reads the rows and parses the snapshot once for the whole set.
 */
function agentHarnessUsable(pluginId: string, declared: NodePluginSet, inv: AgentInventory): boolean {
  // Two conditions, and they are different facts: the node DECLARED the
  // plugin (it is installed there), and its BINARY was seen recently. The
  // enable table that used to be the first condition is gone; a node offering
  // a plugin is now the node having installed it.
  if (!declared.entries.has(pluginId)) return false;
  if (declared.entries.get(pluginId)?.broken) return false;
  return inv.fresh && inv.entries.get(pluginId)?.installed === true;
}

/**
 * The agent-branch rule for one resolved node row: loads the two inputs
 * (per-node enabled rows, parsed inventory) and defers every verdict to the
 * single {@link agentHarnessUsable} predicate.
 */
async function agentHarnessUsableForNode(node: NodeTable, pluginId: string): Promise<boolean> {
  return agentHarnessUsable(pluginId, readNodePlugins(node), readAgentInventory(node));
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
    // Iterate what the NODE declared rather than this server's registry: a
    // node can have a plugin this build has never heard of.
    const declared = readNodePlugins(node);
    const inv = readAgentInventory(node);
    for (const id of declared.entries.keys()) {
      if (agentHarnessUsable(id, declared, inv)) usable.add(id);
    }
    return usable;
  }

  const states = await harnessEnabledStates();
  for (const h of allHarnesses()) {
    if ((states.get(h.id) ?? h.enabledByDefault) && (await h.isInstalled())) usable.add(h.id);
  }
  return usable;
}
