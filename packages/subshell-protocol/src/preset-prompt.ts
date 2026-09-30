/**
 * The wire shape of a preset's launch prompt: the block stack the launch
 * form composes, stored on the preset row WITHOUT the form-local identity the
 * SPA adds back on load. Bodies are SNAPSHOTS taken at pick time (the same
 * rule the new-subshell form's stack follows): editing or deleting a library
 * prompt later never changes what a preset launches, which is what makes a
 * cross-comm-ready preset's text knowable from the row alone.
 *
 * Pure TypeScript - the mobile app imports this package through Metro, which
 * cannot resolve `node:` builtins, so nothing here may reach one.
 */

/** One block of a preset's prompt stack. */
export interface PresetPromptBlock {
  /** A saved prompt picked from the library, a custom typed block, or a stack picked whole. */
  kind: "saved" | "custom" | "stack";
  /** The library id a saved block came from (provenance for the row's label; absent for custom and stack). */
  promptId?: string;
  /** The library id a stack block came from (absent for saved and custom). */
  stackId?: string;
  /** Member count a stack block carries, kept from the pick (NOT re-derived: a member's own text may contain the blank-line join). */
  stackCount?: number;
  /** The block's label as stored; an unlabeled custom row carries "" and the list rows render "Untitled" as a display fallback. */
  description: string;
  /** The block's text, snapshotted at pick. */
  body: string;
}

/** Parse a `presets.prompt_blocks` JSON column. Malformed stored JSON is a
 *  server-side impossible state, so this THROWS rather than silently
 *  launching without the prompt the row says it has. */
export function parsePresetPromptBlocks(json: string | null | undefined): PresetPromptBlock[] | null {
  if (json == null || json === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // A broken column says the same thing whatever broke it: the row's prompt
    // is unreadable, which is an impossible state, not a parse report.
    throw new Error("bad_preset_prompt");
  }
  if (!Array.isArray(parsed)) throw new Error("bad_preset_prompt");
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) throw new Error("bad_preset_prompt");
    const block = item as Partial<PresetPromptBlock>;
    if (block.kind !== "saved" && block.kind !== "custom" && block.kind !== "stack") {
      throw new Error("bad_preset_prompt");
    }
    if (typeof block.body !== "string" || typeof block.description !== "string") {
      throw new Error("bad_preset_prompt");
    }
  }
  return parsed as PresetPromptBlock[];
}

/** The exact prompt text a preset's stack types into the pane: the bodies
 *  joined by ONE blank line - byte-identical to the launch form's join. */
export function joinPresetPrompt(blocks: PresetPromptBlock[]): string {
  return blocks.map((b) => b.body).join("\n\n");
}

/** The launch-field requirement of cross-comm readiness: a machine and a
 *  working directory are set on the row. The prompt is OPTIONAL here
 *  (operator re-ruling 2026-09-30, same day as the switch): a preset that
 *  names where to run can be launched by name even when it says nothing to
 *  type; the prompt blocks ride along as launch data when present. */
export function presetLaunchRequirementsMet(row: { nodeId: string | null; workingDir: string | null }): boolean {
  return row.nodeId != null && row.workingDir != null;
}

/** Cross-comm ready: an agent can launch from this preset's NAME alone.
 *  An OPT-IN AND a requirement (rulings of 2026-09-30): the stored
 *  `crossCommEnabled` switch - the editor's "Cross-subshell comms" toggle -
 *  AND the machine + directory (`presetLaunchRequirementsMet`). A preset
 *  nobody switched on makes no agent-facing promise. */
export function isPresetCrossCommReady(row: {
  crossCommEnabled: number | boolean;
  nodeId: string | null;
  workingDir: string | null;
}): boolean {
  return (row.crossCommEnabled === 1 || row.crossCommEnabled === true) && presetLaunchRequirementsMet(row);
}
