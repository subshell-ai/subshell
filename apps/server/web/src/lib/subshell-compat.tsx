import { PluginIcon } from "@/components/plugin-icon";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { InstancePluginRow } from "@/hooks/use-instance-plugins";
import { isOfflineNode, nodeOptionLabel } from "@/lib/node-label";
import { usableFirst } from "@/lib/option-order";
import type { Node } from "@/types/node";

/**
 * The launch picker's compatibility matrix (spec 2026-09-02 §2, re-cut
 * agent-first by spec 2026-09-13 §5), pure so the grey-with-reason grid is
 * testable without opening a Base UI dropdown. This is the INFORMATIONAL
 * mirror of the server's `harnessUsable` — the launch gate stays authoritative
 * server-side (409 harness_disabled covers every race, including a stale
 * agent inventory).
 */

/** The plugin fields the Agent pickers read. */
export type LaunchAgent = Pick<InstancePluginRow, "id" | "name" | "icon" | "installed" | "enabled" | "broken" | "type">;

/**
 * Why a harness cannot launch on a node.
 *
 * "disabled" is gone (spec 2026-09-09 §12): a node offers what it has
 * INSTALLED, so there is no enable flag left to be off. What used to be a
 * disabled harness is now simply a plugin the node does not have, which is
 * "not-installed" and already the row a reader sees.
 */
export type IncompatReason = "offline" | "not-installed";

/**
 * Whether `harnessId` could launch on `node`, informational-grade: an offline
 * agent beats entry state, and an absent entry counts as not-installed — the
 * node either declared the plugin and its binary was seen, or it did not.
 * @returns null when usable, else the reason code
 */
export function harnessFitsNode(node: Node, harnessId: string): IncompatReason | null {
  if (isOfflineNode(node)) return "offline";
  const entry = node.harnesses.find((h) => h.harnessId === harnessId);
  if (!entry?.installed) return "not-installed";
  return null;
}

/**
 * The hedge both sides of the matrix append when a grey rests on STALE
 * inventory: a missing entry there is last-known state, not a confirmed fact.
 */
const STALE_HEDGE = " (inventory may be outdated)";

/**
 * Agent options paired against the chosen node (null = no pick yet: only the
 * server-side flags grey), greyed never hidden (the 2026-09-02 rule,
 * unchanged): reasons in precedence "not installed on this server" →
 * "failed to load" → "disabled on this server" → node reasons ("node
 * offline", "not installed on this node" + the stale hedge).
 * `usableFirst` puts what can be picked on top; each group keeps plugin order.
 */
export function buildAgentOptions(plugins: readonly LaunchAgent[], node: Node | null): ComboboxOption[] {
  return usableFirst(
    // Networks are DROPPED, not greyed — the one exception to greyed-never-
    // hidden, and it is not an exception to the rule so much as a statement
    // that they were never on the list. Greying exists to say "this agent
    // could run here, but not right now"; a plugin that drives no pane can
    // never be launched under any conditions, so a greyed row with a reason
    // would be inventing a story about a choice that does not exist.
    plugins
      .filter((p) => p.type !== "network")
      .map((p) => {
        const opt: ComboboxOption = { value: p.id, label: p.name, disabled: false };
        // Every option gets a mark: `PluginIcon` draws the plugin's own when it
        // declares one and a monogram when it does not, so the labels in this
        // list stay vertically aligned either way.
        opt.icon = <PluginIcon pluginId={p.id} name={p.name} />;
        // Server-side refusals first (they hold no matter what the node says),
        // then the node's own verdict — the precedence is the frozen table's.
        if (!p.installed) {
          opt.disabled = true;
          opt.reason = "not installed on this server";
        } else if (p.broken !== undefined) {
          opt.disabled = true;
          opt.reason = "failed to load";
        } else if (!p.enabled) {
          opt.disabled = true;
          opt.reason = "disabled on this server";
        } else if (node !== null) {
          const fit = harnessFitsNode(node, p.id);
          if (fit !== null) {
            opt.disabled = true;
            opt.reason =
              fit === "offline"
                ? "node offline"
                : `not installed on this node${node.inventoryStale ? STALE_HEDGE : ""}`;
          }
        }
        return opt;
      }),
    (o) => !o.disabled,
  );
}

/**
 * The agent the picker should hold when the user has not chosen one: the most
 * recent subshell's agent when it is still usable, else the first usable
 * NON-terminal agent (a shell is a fallback, not the headline), else anything
 * usable, else null (nothing to fill — the picklist greys everything and the
 * dead-end hints carry the story).
 *
 * @param options - output of {@link buildAgentOptions} for the current pair
 * @param plugins - the plugin rows, for the terminal lookup by id
 * @param recentHarnessId - harnessId of the user's most recent subshell, null when none
 */
export function defaultAgentId(
  options: readonly ComboboxOption[],
  plugins: readonly LaunchAgent[],
  recentHarnessId: string | null,
): string | null {
  const usable = options.filter((o) => !o.disabled);
  if (recentHarnessId !== null && usable.some((o) => o.value === recentHarnessId)) return recentHarnessId;
  const typeById = new Map(plugins.map((p) => [p.id, p.type]));
  // Tested POSITIVELY for `agent-harness`, not negatively against
  // `terminal`. The exclusion was correct while two types existed and became
  // wrong the moment a third did: a network plugin is not a slower agent, and
  // "not a terminal" would have made one the headline default. An absent
  // `type` (a payload older than the field) therefore no longer WINS the
  // first tier — it still reaches the `usable[0]` fallback below, so nothing
  // becomes unpickable, it just stops outranking a declared agent.
  return (usable.find((o) => typeById.get(o.value) === "agent-harness") ?? usable[0])?.value ?? null;
}

/**
 * Node options paired against the chosen agent (null = no pick yet: only
 * offline agents grey). The suggested-node suffix is gone with the pin
 * itself (spec 2026-09-13 §2.3) — the default pick is `pickNodeDefault`'s,
 * unchanged.
 */
export function buildNodeOptions(nodes: readonly Node[], agent: LaunchAgent | null): ComboboxOption[] {
  return usableFirst(
    nodes.map((n) => {
      const offline = isOfflineNode(n);
      // The one unlaunchable row the picker KEEPS (spec 2026-09-14 §6), so it
      // is the one that has to explain itself here. Harness fit is not even
      // asked: a machine nobody may launch on does not owe an answer about
      // which agent it has.
      const maintenance = n.maintenance;
      const fit = !offline && !maintenance && agent !== null ? harnessFitsNode(n, agent.id) : null;
      const opt: ComboboxOption = {
        value: n.id,
        label: nodeOptionLabel(n),
        disabled: offline || maintenance || fit !== null,
      };
      // Offline deliberately carries no reason — its label's last segment is
      // the whole explanation — so a node that is BOTH gets none either:
      // "in maintenance" beside a machine that is down would read as if
      // ending maintenance were the fix.
      if (maintenance && !offline) {
        opt.reason = "in maintenance";
      } else if (fit !== null && agent !== null) {
        const stale = fit === "not-installed" && n.inventoryStale;
        opt.reason = `no ${agent.name} here${stale ? STALE_HEDGE : ""}`;
      }
      return opt;
    }),
    (o) => !o.disabled,
  );
}
