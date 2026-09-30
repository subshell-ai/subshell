import { newRandomId } from "@/lib/random-id";
/**
 * The create dialog's prompt stack (spec 2026-09-28): the blocks the user
 * picked or wrote, their reorder/remove transforms, and the join that
 * becomes the create body's `prompt`. Pure so the contract is testable
 * without a form on screen.
 */

/** One block of the stack: a saved prompt, a stack picked whole, or a custom one. */
export interface PromptBlock {
  /** Form-local identity (uuid at add); never crosses the wire. */
  localId: string;
  /** A stack pick is ONE unit block (spec 2026-09-29): its joined text, snapshot at pick. */
  kind: "saved" | "custom" | "stack";
  /** The library id a saved block came from; absent for custom and stack. */
  promptId?: string;
  /** The library id a stack block came from; the row says "from stack" with it. */
  stackId?: string;
  /** Member count a stack block carries, kept from the pick (NOT re-derived:
   *  a member's own text may contain the blank-line join). */
  stackCount?: number;
  /** The block's label as stored; an unlabeled custom row carries "" and the
   *  list rows render "Untitled" as a display fallback (never baked in). */
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

/**
 * Whether the server's `promptDelivered: false` means a MISSED prompt.
 * The wire field is false for "no prompt at all" too (the create route's
 * documented default), so the toast may only fire when the caller actually
 * stacked one (review fix, spec 2026-09-28).
 */
export function promptLaunchMissed(
  promptEnabled: boolean | undefined,
  promptBlocks: { length: number } | undefined,
  promptDelivered: boolean | undefined,
): boolean {
  return promptDelivered === false && promptEnabled === true && (promptBlocks?.length ?? 0) > 0;
}

/**
 * A localId for a stacked block. NOT a bare `crypto.randomUUID()`: that
 * method exists only in secure contexts, and this app is legitimately
 * served over plain http on a LAN address (operator's dev box, live report
 * 2026-09-29) — there, `randomUUID` is undefined and a plain call THROWS
 * inside the pick handler, which reads as "clicking a prompt does
 * nothing". The picker is a UX action, so the id only needs to be unique
 * among the few blocks one form stacks: the fallback is good enough for
 * that, and it never throws.
 */
export function newPromptLocalId(): string {
  return newRandomId("p");
}
