/**
 * Database table schema for saved prompts (spec 2026-09-28). A prompt is a
 * reusable text snippet with a required short description, owned by one user
 * and optionally shared with EVERYONE (the `shared` column is the whole
 * sharing model: no per-user grants, no permission levels).
 */
export interface PromptTable {
  /** Unique prompt id (uuid) */
  id: string;
  /** Owning user id (better-auth user id) */
  userId: string;
  /** Required short label, trimmed by the route, max 120 chars (the rename cap) */
  description: string;
  /** The prompt text, 1..20000 chars (the create-prompt wire cap) */
  body: string;
  /** 1 = every authenticated account may read this prompt; 0 = owner only */
  shared: number;
  /** ISO 8601 creation timestamp (DB default) */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

/** Insert shape: DB defaults fill createdAt/updatedAt/shared when omitted. */
export type NewPrompt = Omit<PromptTable, "createdAt" | "updatedAt" | "shared"> & { shared?: number };

/** Update shape: any stored column but the identity ones. */
export type PromptUpdate = Partial<Omit<PromptTable, "id" | "userId" | "createdAt">>;
