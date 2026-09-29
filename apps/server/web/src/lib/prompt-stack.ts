/**
 * The create dialog's prompt stack (spec 2026-09-28): the blocks the user
 * picked or wrote, their reorder/remove transforms, and the join that
 * becomes the create body's `prompt`. Pure so the contract is testable
 * without a form on screen.
 */

/** One block of the stack: a saved prompt's text, or a custom one. */
export interface PromptBlock {
  /** Form-local identity (uuid at add); never crosses the wire. */
  localId: string;
  /** Saved rows remember their library id so the block says what it is. */
  kind: "saved" | "custom";
  /** The library id a saved block came from; absent for custom. */
  promptId?: string;
  /** The label the row shows (a custom unsaved block may read "Untitled"). */
  description: string;
  body: string;
}

/**
 * The exact text sent as the create/restart `prompt`: the blocks joined by
 * ONE blank line. The empty stack joins to "" and the caller must send no
 * prompt field at all.
 */
export function joinPromptBlocks(blocks: PromptBlock[]): string {
  return blocks.map((b) => b.body).join("\n\n");
}

/** Swap a block with its neighbour; a no-op at the ends or unknown id. */
export function movePromptBlock(blocks: PromptBlock[], localId: string, dir: -1 | 1): PromptBlock[] {
  const from = blocks.findIndex((b) => b.localId === localId);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= blocks.length) return blocks;
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Drop one block; unknown id changes nothing. */
export function removePromptBlock(blocks: PromptBlock[], localId: string): PromptBlock[] {
  return blocks.filter((b) => b.localId !== localId);
}
