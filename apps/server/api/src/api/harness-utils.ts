import { allHarnesses, getHarness, scanOne } from "@internal/pane-runtime";
import type { Static } from "elysia";
import type { HarnessInfoSchema } from "@/api/models.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { LOCAL_NODE_ID, type NodeTable } from "@/db/types/nodes.db-types.js";
import {
  type AgentInventory,
  type NodePluginSet,
  readAgentInventory,
  readNodePlugins,
} from "@/services/nodes/inventory.js";

/** All known harness plugin ids. */
export function getAllHarnessIds(): string[] {
  return allHarnesses().map((h) => h.id);
}

/**
 * Route error with an HTTP status; the global error handler maps `status` to
 * the response code (the same duck-typed shape the per-route `*Error` classes
 * carry — `SetupError`'s successor). Raised by every plugin-management path,
 * on this host and on an agent, so they produce one wire shape.
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
 * another GET); whether THIS HOST has the plugin comes from the caller, which
 * reads `local`'s own declared set.
 *
 * The probe is {@link scanOne}, the SAME function the node agent runs against
 * its own filesystem, so a local row and an agent row cannot disagree about
 * what an entry means. This used to be a second, hand-rolled implementation
 * here, which is how the server came to report neither a reason nor a
 * timestamp while the agent reported both, and how it came to walk the lookup
 * ladder twice per harness per request.
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
 * Usable = the node DECLARED the plugin (and did not report it broken) AND
 * its binary is installed. The binary half is load-bearing, matching the
 * product rule "if it isn't installed it stays unavailable": a missing
 * program hides the harness's profiles and blocks new subshells even on a
 * host that has the plugin.
 *
 * Node-aware (spec 2026-08-31 §6.2): with no `nodeId` (or `"local"`) the
 * declared set is this host's own and the probe is live. For an AGENT node it
 * is the strict LAUNCH gate: the node
 * DECLARED the plugin and did not report it broken ∧ a FRESH (≤ 10-min TTL)
 * cached inventory that says its binary is installed.
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
  // `local` resolves the same way an agent does: it DECLARED the plugin, and
  // the plugin's binary is present. The difference is only that this host can
  // look now rather than reading a snapshot someone sent.
  const declared = await localDeclaredPlugins();
  const entry = declared.get(id);
  if (!entry || entry.broken) return false;
  const plugin = getHarness(id);
  if (!plugin) return false;
  return await plugin.isInstalled();
}

/**
 * What the control-plane host has installed, by id.
 *
 * Read from the mirror in its own node row rather than from the disk, so the
 * gate and the view answer from one source. Boot writes it and every install
 * refreshes it.
 */
async function localDeclaredPlugins(): Promise<Map<string, { broken?: string }>> {
  const node = await new NodesRepository(db).findById(LOCAL_NODE_ID);
  return node ? readNodePlugins(node).entries : new Map();
}

/**
 * The ONE spelling of the agent-node launch gate for one (plugin × node)
 * pair (ledger 17b — dedups the rule previously spelled here AND in
 * {@link usableHarnessIds}): the node declared the plugin and did not report
 * it broken ∧ a FRESH inventory that explicitly says installed. Pure — the
 * caller supplies the declared set and the parsed inventory, so the batch
 * path reads and parses each once for the whole set.
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
 * The agent-branch rule for one resolved node row: loads the two inputs (the
 * node's declared plugin set, its parsed inventory) and defers every verdict
 * to the single {@link agentHarnessUsable} predicate.
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

  // `local`, resolved the same way: declared here, and its binary present.
  const declared = await localDeclaredPlugins();
  for (const h of allHarnesses()) {
    const entry = declared.get(h.id);
    if (entry && !entry.broken && (await h.isInstalled())) usable.add(h.id);
  }
  return usable;
}
