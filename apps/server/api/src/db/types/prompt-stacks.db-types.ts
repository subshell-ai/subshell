/**
 * Database table schemas for prompt stacks (spec 2026-09-29). A stack is an
 * ordered collection of prompts with a short label, owned by one user and
 * shared with EVERYONE or nobody - the same `shared` column rule as a single
 * prompt. Membership lives in `prompt_stack_items`: each row is either a live
 * reference to a saved prompt (edits show through; deleting the prompt removes
 * it here by FK cascade, which is what makes empty stacks a real state) or the
 * stack's own inline free-text row.
 */
export interface PromptStackTable {
  /** Unique stack id (uuid) */
  id: string;
  /** Owning user id (better-auth user id) */
  userId: string;
  /** Required short label, trimmed by the route, max 120 chars (the rename cap) */
  label: string;
  /** 1 = every authenticated account may read this stack; 0 = owner only */
  shared: number;
  /** ISO 8601 creation timestamp (DB default) */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

/** Insert shape: DB defaults fill createdAt/updatedAt/shared when omitted. */
export type NewPromptStack = Omit<PromptStackTable, "createdAt" | "updatedAt" | "shared"> & { shared?: number };

/** Update shape: any stored column but the identity ones. */
export type PromptStackUpdate = Partial<Omit<PromptStackTable, "id" | "userId" | "createdAt">>;

/**
 * One ordered member of a stack. Exactly one of `promptId` / `body` is set
 * (CHECK-enforced): a reference row carries the live `promptId` and no body
 * (the prompt's own text and description show through), an inline row carries
 * `body` and a `description` label. Unsharing a referenced prompt is not a row
 * change - read views drop members the caller cannot see.
 */
export interface PromptStackItemTable {
  /** Unique item id (uuid) */
  id: string;
  /** Owning stack */
  stackId: string;
  /** Position in the stack, 0-based, unique per stack */
  ordinal: number;
  /** Referenced prompt (FK, ON DELETE CASCADE - the delete rule), or null for an inline row */
  promptId: string | null;
  /** Inline free-text body (the stack's own), or null for a reference row */
  body: string | null;
  /** Label for an inline row; null on reference rows (the prompt's own description labels them) */
  description: string | null;
}

/** Item as callers hand it in; the id and ordinal are assigned by the repository. */
export type NewPromptStackItem = Pick<PromptStackItemTable, "promptId" | "body" | "description">;
