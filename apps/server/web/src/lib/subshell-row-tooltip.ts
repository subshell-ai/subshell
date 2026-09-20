import { INDICATOR_LABEL, subshellIndicator } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

/**
 * The hover text of a sidebar subshell row.
 *
 *     Name: auth-refactor
 *     Node: mac-mini
 *     Agent: Claude Code
 *     Status: working
 *     Directory: /Users/theo/projects/auth
 *
 * Two duties, and the second is why the first two lines are HERE rather than
 * being the whole string: the row truncates both the name and the working
 * directory at rail width, so the tooltip is the only way to read either in
 * full — the pre-grouping `title` (`name: workingDir`) existed for exactly
 * that and stays honored. The three labelled lines the 2026-09-20 grouping
 * asked for (node, agent, status) sit between them: the answers someone
 * hovers FOR, framed by the two strings they hover to FINISH READING. The
 * path goes last because it is the longest line, and a native tooltip shows
 * what fits — ordering keeps the answers above a long path's fold.
 *
 * A native `title` rather than the styled `ui/tooltip` component,
 * deliberately: the row is a `Link` that is also `draggable` and also the
 * trigger of a context menu, and a third render-prop wrapper around one
 * element is where one of those three gestures quietly stops working.
 *
 * `Status` uses the SHARED indicator word, the same one the dot beside it
 * shows and the same one the home card's badge shows.
 *
 * @param subshell - the row's subshell
 * @param nodeLabel - the node's NAME, resolved by the caller (never its id);
 *                    undefined omits the line rather than guessing
 * @param agentLabel - the harness's display name, or its id as a readable
 *                     fallback ("claude-code")
 */
export function subshellRowTooltip(subshell: SubshellView, nodeLabel: string | undefined, agentLabel: string): string {
  const lines = [
    `Name: ${subshell.name}`,
    nodeLabel ? `Node: ${nodeLabel}` : undefined,
    `Agent: ${agentLabel}`,
    `Status: ${INDICATOR_LABEL[subshellIndicator(subshell)]}`,
    subshell.workingDir ? `Directory: ${subshell.workingDir}` : undefined,
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}
