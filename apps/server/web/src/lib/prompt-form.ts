import type { OwnPromptRow } from "./prompts";

/**
 * The pure half of the prompt editor (spec 2026-09-28): the draft shape the
 * dialog edits, the clone-name suggestion (the presets twin's rule), and the
 * client-side validation the server also enforces. Kept out of the component
 * so the rules are testable without a dialog on screen.
 */

/** What the editor holds; the wire body for POST and the PUT patch alike. */
export interface PromptDraft {
  description: string;
  body: string;
  shared: boolean;
}

/** Seed an edit/clone dialog from a stored row (only the three editable fields). */
export function promptDraftFromRow(row: Pick<OwnPromptRow, "description" | "body" | "shared">): PromptDraft {
  return { description: row.description, body: row.body, shared: row.shared };
}

/**
 * The clone's starting label: `Copy of X`, walking `(2)`, `(3)`… past every
 * description the user already has (the preset editor's rule; descriptions
 * are NOT unique on the server, but a list full of "Copy of Kickoff" helps
 * nobody, so the dialog offers the next free spelling).
 */
export function suggestCloneDescription(existing: { description: string }[], source: { description: string }): string {
  const taken = new Set(existing.map((p) => p.description));
  // Clamp first, then walk: the seed must pass the dialog's own 120-char
  // validation, so the SUFFIX reserves room before the name is trimmed
  // (review fix; a 120-char source used to seed an instantly-invalid draft).
  const stem = `Copy of ${source.description}`;
  let n: number | undefined;
  let candidate = stem;
  while (taken.has(candidate)) {
    n = (n ?? 1) + 1;
    candidate = `${stem} (${n})`;
  }
  const suffix = n === undefined ? "" : ` (${n})`;
  const budget = 120 - suffix.length;
  if (stem.length <= budget) return candidate;
  return `${stem.slice(0, budget)}${suffix}`;
}

/** The inline error sentence, or null when the draft is submittable. */
export function validatePromptDraft(draft: PromptDraft): string | null {
  if (draft.description.trim() === "") return "A short description is required";
  if (draft.description.trim().length > 120) return "The description must be 120 characters or fewer";
  if (draft.body.trim() === "") return "The prompt text is required";
  return null;
}
