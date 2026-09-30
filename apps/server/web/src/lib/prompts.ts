/**
 * The client shapes of `/api/prompts` (spec 2026-09-28) and the prompt
 * filter, kept out of the components so the rules are testable without a
 * DOM. The API's view of a prompt differs by ownership: the owner sees the
 * `shared` flag, a reader of someone else's row sees the owner's label and
 * no flag (it is shared by definition of it being in that list).
 */

/** One of the caller's own saved prompts. */
export interface OwnPromptRow {
  id: string;
  description: string;
  body: string;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Another account's shared prompt, as `GET /api/prompts` answers it. */
export interface SharedPromptRow {
  id: string;
  description: string;
  body: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
}

/** The `GET /api/prompts` body. */
export interface PromptsView {
  own: OwnPromptRow[];
  shared: SharedPromptRow[];
}

/**
 * The page's filter: case-insensitive, matches the description OR the
 * body, a blank query keeps everything. The picker filters inside the
 * shared combobox, whose filter carries the same per-field, trimmed
 * semantics (ui/combobox.tsx).
 */
export function matchesPromptQuery(p: { description: string; body: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return p.description.toLowerCase().includes(q) || p.body.toLowerCase().includes(q);
}
