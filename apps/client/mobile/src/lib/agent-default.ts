import type { PluginView } from "@/types/plugin";
import type { SubshellView } from "@/types/subshell";

/**
 * The New screen's default-agent rule (spec 2026-09-13 §5) — the mobile
 * mirror of `defaultAgentId` in
 * `apps/server/web/src/lib/subshell-compat.ts` (its call site there is
 * `apps/server/web/src/components/subshell-picker/new-subshell-form.tsx`),
 * kept in step by hand (the repo convention for this screen; change one,
 * change both). Pure so the rule is testable without a device.
 *
 * "Usable" is the 2026-09-02 rule, greyed-never-hidden's other half: the
 * instance has the plugin installed AND enabled AND it loaded (!broken), AND
 * the currently selected node reports its binary installed — the same
 * `harnessUsable` conjunction the web chips grey by, and the server's 409
 * stays the backstop for the race.
 *
 * The order: the harness of the user's most recent subshell while usable →
 * the first usable plugin whose type IS `agent-harness` → anything usable →
 * null.
 *
 * That middle tier is a positive test, not the old `!== "terminal"`. The
 * exclusion was right while two types existed and became wrong the moment a
 * third did — a network plugin drives no pane, and "not a terminal" would
 * have made one the headline default. A missing `type` (an older server) no
 * longer wins that tier; it still reaches the "anything usable" fallback, so
 * nothing becomes unpickable.
 *
 * @param plugins - the instance catalog (`GET /api/plugins`)
 * @param nodeHarnessInstalled - whether the SELECTED node reports this
 *   harness's binary installed (caller passes `true` when the node carries no
 *   inventory — unknown must not block)
 * @param recentHarnessId - harness of the newest subshell, or null
 */
export function defaultAgentId(
  plugins: PluginView[],
  nodeHarnessInstalled: (harnessId: string) => boolean,
  recentHarnessId: string | null,
): string | null {
  // A network plugin is not "an agent that cannot run here" — it drives no
  // pane at all, so it is not usable under any conditions and never reaches
  // the last-resort tier below. The catalog read already filters these out
  // (`hooks/use-plugins.ts`); this is the rule itself being true rather than
  // relying on its one caller.
  const usable = (p: PluginView) =>
    p.type !== "network" && p.installed && p.enabled && !p.broken && nodeHarnessInstalled(p.id);
  if (recentHarnessId) {
    const recent = plugins.find((p) => p.id === recentHarnessId);
    if (recent && usable(recent)) return recent.id;
  }
  const usableAgents = plugins.filter(usable);
  return usableAgents.find((p) => p.type === "agent-harness")?.id ?? usableAgents[0]?.id ?? null;
}

/**
 * The harness of the newest subshell by `createdAt`, or null for an empty
 * list — the input the default rule above wants (spec §5: "the agent of the
 * user's most recent subshell when usable"; the polled list already holds the
 * data, no new request). ISO strings compare lexicographically.
 */
export function mostRecentHarnessId(subshells: Pick<SubshellView, "harnessId" | "createdAt">[]): string | null {
  let newest: Pick<SubshellView, "harnessId" | "createdAt"> | null = null;
  for (const s of subshells) {
    if (!newest || s.createdAt > newest.createdAt) newest = s;
  }
  return newest?.harnessId ?? null;
}

/**
 * The default fill gated on the subshells list having ANSWERED (ruled
 * 2026-09-13, cross-client): the recent tier is only evaluable once the list
 * replies, and filling before it does would let load timing choose the
 * user's default agent. A still-pending or errored dataless list (query
 * `data` undefined) answers nothing and returns null; an answered-EMPTY list
 * is a real answer — recent tier skipped, first-usable stands.
 */
export function agentDefault(
  plugins: PluginView[] | undefined,
  nodeHarnessInstalled: (harnessId: string) => boolean,
  subshells: Pick<SubshellView, "harnessId" | "createdAt">[] | undefined,
): string | null {
  if (!plugins || subshells === undefined) return null;
  return defaultAgentId(plugins, nodeHarnessInstalled, mostRecentHarnessId(subshells));
}
