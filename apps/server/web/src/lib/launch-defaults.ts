import type { NewSubshellFormValue } from "@/components/subshell-picker/launch-form-rules";
import { sortByCreation } from "@/lib/subshell-order";
import type { SubshellView } from "@/types/subshell";

/**
 * The launch settings a prior subshell carries — the four fields of
 * `NewSubshellFormValue`. This is the operator's rule (2026-09-25): the form
 * opens pre-filled with the newest row's settings. (The "Copy settings from"
 * picker that applied any listed row was removed with spec
 * 2026-09-29-preset-launch-fields: presets carry that reuse now.)
 *
 * Purely data, no server round trip: every field already rides
 * `GET /api/subshells`, so "remember my last launch" needs no new store —
 * same posture as the agent default, which reads the same live list.
 */
export interface LaunchTemplate {
  /** The row this came from */
  subshellId: string;
  harnessId: string;
  /** null = the prior launch was presetless */
  presetId: string | null;
  nodeId: string;
  workingDir: string;
}

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
    // A block already stacked is an edit: the prior-launch default must not
    // apply over a section the user filled while the node list was still
    // loading (spec 2026-09-28; the checkbox left with the 2026-09-30
    // shared-section ruling, and the stack itself is the touched fact).
    value.promptBlocks.length === empty.promptBlocks.length
  );
}
