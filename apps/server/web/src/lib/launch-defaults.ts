import type { Node } from "@internal/node-admin";
import type { NewSubshellFormValue } from "@/components/subshell-picker/launch-form-rules";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { LaunchAgent } from "@/lib/subshell-compat";
import { sortByCreation } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/**
 * The launch settings a prior subshell carries — the four fields of
 * `NewSubshellFormValue`. This is the operator's rule (2026-09-25): the form
 * opens pre-filled with the newest row's settings, and the "Copy settings
 * from" picker applies any listed row's settings as an explicit act.
 *
 * Purely data, no server round trip: every field already rides
 * `GET /api/subshells`, so "remember my last launch" needs no new store —
 * same posture as the agent default, which reads the same live list.
 */
export interface LaunchTemplate {
  /** The row this came from — what the picker matches a selection on */
  subshellId: string;
  harnessId: string;
  /** null = the prior launch was presetless */
  presetId: string | null;
  nodeId: string;
  workingDir: string;
}

/** The copy picker's two categories (operator ruling 2026-09-29). */
export const ACTIVE_GROUP = "Active";
export const RECENTLY_TERMINATED_GROUP = "Recently terminated";

/**
 * How many rows of EACH category the picker shows before you search. The
 * unfiltered list is deliberately short and tidy (max 3 active over max 3 just
 * ended); typing lifts the cap, so a search still reaches every row — the cap
 * is a calm default, never a ceiling.
 */
export const COPY_CATEGORY_PREVIEW = 3;

/**
 * The launch settings one row carries, with the older-payload coercions the
 * view type's optionals imply (a cached row without `nodeId`/`workingDir`
 * reads as the wire's defaults, never as undefined).
 */
export function launchTemplateFromRow(row: SubshellView): LaunchTemplate {
  return {
    subshellId: row.id,
    harnessId: row.harnessId,
    presetId: row.presetId ?? null,
    // `nodeId` stays optional in the view type for cached older payloads (same
    // tolerance as `preview`); absent reads as the wire's other default.
    nodeId: row.nodeId ?? "local",
    workingDir: row.workingDir ?? "",
  };
}

/**
 * The settings of the user's most recent prior subshell: `sortByCreation`
 * head — the SAME selector that feeds `defaultAgentId`'s recent tier, so the
 * agent default and the full-settings default can never disagree about which
 * row is "recent". Terminated and shared rows are eligible (the row you
 * re-launch from is usually finished), and an unsafe copy degrades through
 * the form's existing arms, not a filter here.
 *
 * @param list - the live subshells list; undefined/null = not answered yet
 */
export function launchTemplateFromList(list: readonly SubshellView[] | undefined | null): LaunchTemplate | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  return launchTemplateFromRow(sortByCreation(list)[0]);
}

/**
 * Whether the form still holds the untouched empty baseline. This is the
 * auto-default's disqualifier: a Split `initialForm`, a caller seed, or a
 * field the user typed before the list answered all fail it, so the prior
 * settings never override a held or edited value. The caller passes
 * `emptyNewSubshellForm()` as the baseline; nothing duplicates the empty
 * values here.
 */
export function isUntouchedForm(value: NewSubshellFormValue, empty: NewSubshellFormValue): boolean {
  return (
    value.harnessId === empty.harnessId &&
    value.presetId === empty.presetId &&
    value.nodeId === empty.nodeId &&
    value.workingDir === empty.workingDir &&
    // A ticked "Add a prompt" (or a block already picked) is an edit: the
    // prior-launch default must not apply over a section the user opened
    // while the node list was still loading (spec 2026-09-28).
    value.promptEnabled === empty.promptEnabled &&
    value.promptBlocks.length === empty.promptBlocks.length
  );
}

function agentName(plugins: readonly LaunchAgent[], harnessId: string): string {
  // An unknown plugin slug shows raw (the Clone dialog's posture): the copy
  // is still that row, and a name the catalog does not know would be invented.
  return plugins.find((p) => p.id === harnessId)?.name ?? harnessId;
}

function nodeShortName(nodes: readonly Node[], nodeId: string): string {
  const found = nodes.find((n) => n.id === nodeId);
  // Unresolved node (deleted, or a list that has not answered yet): the short
  // id, the sidebar group header's ladder, not a name that proves nothing.
  return found?.name ?? nodeId.slice(0, 8);
}

/** One copy-picker row: the subshell's name, and `agent · node · dir` detail. */
function copyOption(
  s: SubshellView,
  nodes: readonly Node[],
  plugins: readonly LaunchAgent[],
  group?: string,
): ComboboxOption {
  return {
    value: s.id,
    // `name` is required in the view type but fixtures and older payloads
    // can omit it; the id is the only other thing a row is sure to carry.
    label: s.name || s.id,
    // A missing directory (older payload) drops its segment rather than
    // dangling a separator it cannot fill.
    reason: [agentName(plugins, s.harnessId), nodeShortName(nodes, s.nodeId ?? "local"), s.workingDir ?? ""]
      .filter((part) => part !== "")
      .join(" · "),
    ...(group === undefined ? {} : { group }),
  };
}

/** Ended-most-recent first; a null `endedAt` (a row that died before the
 *  stamp existed) sinks below the dated ones rather than throwing. */
function byEndedRecent(a: SubshellView, b: SubshellView): number {
  const x = a.endedAt ?? "";
  const y = b.endedAt ?? "";
  if (x !== y) return x < y ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The "Copy settings from" options, split into two categories (operator
 * ruling 2026-09-29): **Recently terminated** (just-stopped rows, newest
 * ended first, led by `endedAt`) then **Active** (everything still running,
 * newest created first). Every eligible row is returned so a typed search
 * reaches the deep list — the short per-category view is the combobox's
 * preview cap (`COPY_CATEGORY_PREVIEW`), not a slice here.
 *
 * label = the subshell's name, muted `reason` = `agent · node · dir` (the
 * combobox's detail slot). NEVER disabled — copying settings from a row on an
 * offline node or with a vanished preset is useful, and the form's existing
 * arms (re-home clearing the dir like a machine switch, the preset-membership
 * guard) degrade the applied copy exactly as they degrade anything else.
 */
export function copySettingsOptions(
  list: readonly SubshellView[] | undefined | null,
  nodes: readonly Node[],
  plugins: readonly LaunchAgent[],
): ComboboxOption[] {
  if (!Array.isArray(list)) return [];
  // ONE entry per subshell, by id: the two categories are already status-
  // disjoint, but a payload that carries the same id twice (an older cache
  // mid-merge) must never list one subshell twice (operator rule 2026-09-29).
  // First occurrence wins, so the ordering below is unaffected for real data.
  const seen = new Set<string>();
  const rows = list.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  const terminated = rows.filter((s) => s.status === "terminated").sort(byEndedRecent);
  // "Active" is everything not terminated (a running row, or an older cached
  // payload that predates the field — never silently dropped from the picker).
  const active = sortByCreation(rows.filter((s) => s.status !== "terminated"));
  return [
    ...terminated.map((s) => copyOption(s, nodes, plugins, RECENTLY_TERMINATED_GROUP)),
    ...active.map((s) => copyOption(s, nodes, plugins, ACTIVE_GROUP)),
  ];
}
