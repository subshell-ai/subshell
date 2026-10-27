/**
 * The plane's mirror of the node-owned preview refusal words (pane-preview
 * spec §6's naming rule: refusals surface NAMED, never reworded into
 * silence). The words are authored on the node (`apps/node/agent/src/
 * preview/ports.ts`, `preview/display.ts`, `commands/preview-ports-exec.ts`)
 * and arrive here verbatim inside `NodeRpcError.detail`; this module only
 * pins the spellings and pairs each with the operator's remedy, the same
 * shape `packages/subshell-protocol/src/ssh-errors.ts` is for ssh refusals.
 *
 * Some words throw bare and some carry a colon suffix naming which resource
 * ran out (`preview-display-missing-requirements: x11vnc`), so matching is by
 * WORD or WORD-with-suffix, never a bare substring.
 */

/** The ports scan refused: this platform has no /proc walk (spec §6). */
export const PREVIEW_PORTS_UNSUPPORTED = "preview-ports-unsupported";
/** The ports scan refused: the pane is not running on that node anymore. */
export const PREVIEW_PORTS_PANE_GONE = "preview-ports-pane-gone";
/** The node's own preview switch is off; the word carries the remedy. */
export const PREVIEW_NODE_OFF = "preview-node-off: turn on Preview for this node";
/** A screen launch refused: the selected provider does not support this machine. */
export const PREVIEW_DISPLAY_UNSUPPORTED = "preview-display-unsupported";
/** A screen launch refused; the thrown message names an unmet requirement. */
export const PREVIEW_DISPLAY_MISSING_REQUIREMENTS = "preview-display-missing-requirements";
/** A screen launch refused; the detail names what failed to come up. */
export const PREVIEW_DISPLAY_NOT_READY = "preview-display-not-ready";
/** The open executor refused: the named pane is gone. */
export const PREVIEW_PANE_GONE = "preview-pane-gone";
/** The open executor refused: the port is not a CDP endpoint. */
export const PREVIEW_NOT_CDP = "not-cdp";

/**
 * Does a node refusal's detail name `word`? True for the bare word and for
 * the word with its suffix (`word: something`), so the pair survives the
 * agent's richer messages while a substring hit inside another word cannot
 * create a false match.
 */
export function detailNamesWord(detail: string, word: string): boolean {
  return detail === word || detail.startsWith(`${word}: `);
}

/** A node switch-off refusal's detail: the bare prefix or the full remedy string. */
export function detailIsNodeOff(detail: string): boolean {
  return detailNamesWord(detail, "preview-node-off");
}

/**
 * The screen-launch remedies, keyed by word. `launch` (Task 9's create path)
 * renders these as 400s that name both the refusal and the next step; the
 * node's own words ride along so the operator can grep them.
 */
export const SCREEN_LAUNCH_REMEDIES: Readonly<Record<string, string>> = {
  "preview-display-provider-disabled":
    "This display provider is disabled on the node. Enable it in node settings, or choose another provider for a new subshell.",
  "preview-display-provider-conflict":
    "This subshell already has a display from a different provider. Start a new subshell to use another provider.",
  "preview-node-off":
    "Virtual displays are disabled on this node. Turn on Allow virtual displays in node settings, then launch again.",
  [PREVIEW_DISPLAY_UNSUPPORTED]:
    "The selected virtual display provider is not supported on this node. Choose a supported provider in node settings, or launch without a virtual display.",
  [PREVIEW_DISPLAY_MISSING_REQUIREMENTS]:
    "The selected virtual display provider has unmet requirements. Check the requirements in node settings, or launch without a virtual display.",
  [PREVIEW_DISPLAY_NOT_READY]:
    "That node's virtual display did not come up inside the launch budget, so the screen pane was refused. Try again, or launch without a screen.",
};

/**
 * The remedy for a screen launch the NODE refused: the paired sentence when
 * the word is known, plus the node's own detail verbatim. The word ALWAYS
 * rides along, bare form included: the sentence explains, the word is what a
 * reader greps and what the dashboard matches to decide the refusal belongs
 * beside the Virtual display control rather than at the bottom of the form
 * (`isDisplayLaunchRefusal`). A refusal this mirror does not speak is null,
 * untouched.
 */
export function screenLaunchRemedy(detail: string): string | null {
  for (const [word, remedy] of Object.entries(SCREEN_LAUNCH_REMEDIES)) {
    if (detail === word || detail.startsWith(`${word}: `)) {
      return `${remedy} (${detail})`;
    }
  }
  return null;
}
