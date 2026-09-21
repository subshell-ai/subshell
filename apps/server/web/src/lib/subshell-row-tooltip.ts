import { INDICATOR_LABEL, subshellIndicator } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

/**
 * The hover text of a sidebar subshell row.
 *
 *     Name: auth-refactor
 *     Node: mac-mini
 *     Agent: Claude Code
 *     Preset: review mode
 *     Status: working
 *     Directory: /Users/theo/projects/auth
 *
 * Two duties, and the second is why the first two lines are HERE rather than
 * being the whole string: the row truncates both the name and the working
 * directory at rail width, so the tooltip is the only way to read either in
 * full; the pre-grouping `title` (`name: workingDir`) existed for exactly
 * that and stays honored. The three labelled lines the 2026-09-20 grouping
 * asked for (node, agent, status) sit between them: the answers someone
 * hovers FOR, framed by the two strings they hover to FINISH READING. The
 * path goes last because it is the longest line, and a native tooltip shows
 * what fits; ordering keeps the answers above a long path's fold.
 *
 * A native `title` rather than the styled `ui/tooltip` component,
 * deliberately: the row is a `Link` that is also `draggable` and also the
 * trigger of a context menu, and a third render-prop wrapper around one
 * element is where one of those three gestures quietly stops working.
 *
 * `Status` uses the SHARED indicator word, the same one the dot beside it
 * shows and the same one the home card's badge shows.
 *
 * Every row lives inside a group whose header already had to answer "which
 * machine?", the grouping ladder's honest fallback included, so
 * `nodeLabel` is simply that same label, one source of truth for both the
 * header and the tooltip, never a second guess at it.
 *
 * `Preset` sits with the other answered-because-you-hovered-for-it lines, and
 * it is the one that OMITS itself: a launch made without a preset has no
 * preset, and "Preset: none" on every terminal row would be the tooltip
 * explaining the absence of a thing nobody wondered about. A `presetId` whose
 * preset cannot be named (still loading, or since deleted) shows the id
 * rather than vanishing: the row demonstrably HAS a preset, and an
 * unresolvable one is the fact worth seeing.
 *
 * @param subshell - the row's subshell
 * @param nodeLabel - the group header's label (the node's NAME when the
 *                    registry resolved it; its fallback otherwise)
 * @param agentLabel - the harness's display name, or its id as a readable
 *                     fallback ("claude-code")
 * @param presetLabel - the preset's name when one is chosen and resolved;
 *                      its id when one is chosen but cannot be named;
 *                      `undefined` when the launch has no preset at all
 */
export function subshellRowTooltip(
  subshell: SubshellView,
  nodeLabel: string,
  agentLabel: string,
  presetLabel?: string,
): string {
  const lines = [
    `Name: ${subshell.name}`,
    `Node: ${nodeLabel}`,
    `Agent: ${agentLabel}`,
    presetLabel ? `Preset: ${presetLabel}` : undefined,
    `Status: ${INDICATOR_LABEL[subshellIndicator(subshell)]}`,
    subshell.workingDir ? `Directory: ${subshell.workingDir}` : undefined,
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}
