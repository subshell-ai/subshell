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
 * the first usable NON-terminal agent (the manifest `type` puts Terminal
 * last; a missing `type` from an older server reads as non-terminal, the same
 * old-build posture as `canLaunch`) → anything usable → null.
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
  const usable = (p: PluginView) => p.installed && p.enabled && !p.broken && nodeHarnessInstalled(p.id);
  if (recentHarnessId) {
    const recent = plugins.find((p) => p.id === recentHarnessId);
    if (recent && usable(recent)) return recent.id;
  }
  const usableAgents = plugins.filter(usable);
  return usableAgents.find((p) => p.type !== "terminal")?.id ?? usableAgents[0]?.id ?? null;
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
