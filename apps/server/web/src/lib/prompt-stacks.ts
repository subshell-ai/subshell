/**
 * The client shapes of `/api/prompts/stacks` (spec 2026-09-29) and the pure
 * rules the page and the picker share: search matching (label OR any member,
 * the prompt filter's semantics stretched over the collection), the count /
 * "Empty" line, the joined text (the SAME one blank line the launch stack
 * joins with), and the prompt-to-stacks cross-link derivation.
 *
 * The cross-links are derived HERE, from the stacks payload, on purpose: the
 * payload holds only stacks the caller can see, so an invisible stack can
 * never contribute to a prompt's "In N stacks" count, exactly the API's
 * disclosure rule without a second server round-trip.
 */

/** One member as any reader sees it: refs resolve through to live prompt text. */
export interface StackItemRow {
  id: string;
  /** Present on a reference member: the live prompt it points at. */
  promptId?: string;
  /** Reference member: the prompt's description; inline member: its label ("" when none). */
  description: string;
  body: string;
  /** Present when this member is someone else's shared prompt. */
  ownerName?: string;
}

/** The caller's own stack; `items` already dropped members the caller cannot see. */
export interface OwnStackRow {
  id: string;
  label: string;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
  items: StackItemRow[];
}

/** Another account's shared stack. */
export interface SharedStackRow {
  id: string;
  label: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
  items: StackItemRow[];
}

/** Either list row; everything the pure helpers below reason about. */
export type StackRow = OwnStackRow | SharedStackRow;

/** The `GET /api/prompts/stacks` body. */
export interface StacksView {
  own: OwnStackRow[];
  shared: SharedStackRow[];
}

/** The stack as one text: members joined by ONE blank line (the launch rule). */
export function stackJoinedText(stack: { items: readonly StackItemRow[] }): string {
  return stack.items.map((i) => i.body).join("\n\n");
}

/**
 * The page and picker filter for stacks: case-insensitive over the label OR
 * any member's description/body, a blank query keeping everything. A stack
 * whose VISIBLE members match is a match: the same question the prompt filter
 * answers, asked of the collection.
 */
export function matchesStackQuery(stack: StackRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (stack.label.toLowerCase().includes(q)) return true;
  return stack.items.some((i) => i.description.toLowerCase().includes(q) || i.body.toLowerCase().includes(q));
}

/** The detail line under a stack's label: a count, or the "Empty" state. */
export function stackCountLabel(items: readonly StackItemRow[]): string {
  return items.length === 0 ? "Empty" : `${items.length} ${items.length === 1 ? "prompt" : "prompts"}`;
}

/**
 * The stacks (from a visible payload) that reference the given prompt. The
 * cross-link source for a prompt row's "In N stacks" affordance; inline
 * members have no promptId and never appear.
 */
export function stacksWithPrompt<T extends StackRow>(stacks: readonly T[], promptId: string): T[] {
  return stacks.filter((s) => s.items.some((i) => i.promptId === promptId));
}
