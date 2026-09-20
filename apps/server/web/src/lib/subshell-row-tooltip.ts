import { INDICATOR_LABEL, subshellIndicator } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

/**
 * The hover text of a sidebar subshell row: the three facts the row itself
 * cannot spell out at rail width.
 *
 *     Node: mac-mini
 *     Agent: Claude Code
 *     Status: working
 *
 * The working directory stays OUT of it — it is already rendered under the
 * name, and repeating it would push the three answers below the fold of a
 * native tooltip on a long path.
 *
 * A native `title` rather than the styled `ui/tooltip` component, deliberately:
 * the row is a `Link` that is also `draggable` and also the trigger of a
 * context menu, and a third render-prop wrapper around one element is where
 * one of those three gestures quietly stops working.
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
    nodeLabel ? `Node: ${nodeLabel}` : undefined,
    `Agent: ${agentLabel}`,
    `Status: ${INDICATOR_LABEL[subshellIndicator(subshell)]}`,
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}
