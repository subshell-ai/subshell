import { z } from "zod";
import type { ToolDeps } from "./tools.js";

/**
 * The saved-prompt tools (spec 2026-09-28): full CRUD over the OWNER's
 * prompt library, riding `/api/prompts`. The server resolves this pane's
 * token to its owner with boost and shares off (auth-guard), so "your
 * prompts" here means exactly the human's own rows plus everyone-else's
 * shared ones. The `shared` flag is writable from here too: the operator
 * ruling gave panes the full surface, and the tools say plainly what a
 * `shared: true` write does (it publishes the text to every account on the
 * instance) because that is the one consequence an agent should not have to
 * guess.
 */

/** One prompt as `list_prompts` answers it: enough to pick, not the body. */
export interface PromptBrief {
  id: string;
  description: string;
  /** First line of the body, sliced to 120 chars */
  bodyPreview: string;
  updatedAt: string;
  /** Own rows only: the everyone-or-none flag */
  shared?: boolean;
  /** Shared rows only: the owner's display label */
  ownerName?: string;
}

interface PromptWireRow {
  id: string;
  description: string;
  body: string;
  shared?: boolean;
  ownerName?: string;
  createdAt: string;
  updatedAt: string;
}

function brief(row: PromptWireRow): PromptBrief {
  const firstLine = row.body.split("\n", 1)[0] ?? "";
  return {
    id: row.id,
    description: row.description,
    bodyPreview: firstLine.length > 120 ? firstLine.slice(0, 120) : firstLine,
    updatedAt: row.updatedAt,
    ...(row.shared !== undefined ? { shared: row.shared } : {}),
    ...(row.ownerName !== undefined ? { ownerName: row.ownerName } : {}),
  };
}

/** `list_prompts`: the pane owner's own prompts plus everyone-else's shared ones. */
export async function listPrompts(deps: ToolDeps): Promise<{ own: PromptBrief[]; shared: PromptBrief[] }> {
  const res = await deps.api.req<{ own: PromptWireRow[]; shared: PromptWireRow[] }>("/api/prompts");
  return { own: res.own.map(brief), shared: res.shared.map(brief) };
}

/** `get_prompt`: the full row (body included) by id. */
export async function getPrompt(deps: ToolDeps, args: { id: string }): Promise<PromptWireRow> {
  return deps.api.req<PromptWireRow>(`/api/prompts/${encodeURIComponent(args.id)}`);
}

/** `create_prompt`: saves a prompt owned by the pane's owner. */
export async function createPrompt(
  deps: ToolDeps,
  args: { description: string; body: string; shared?: boolean },
): Promise<PromptWireRow> {
  return deps.api.req<PromptWireRow>("/api/prompts", { method: "POST", body: args });
}

/** `update_prompt`: partial patch; `shared` flips the everyone-or-none read. */
export async function updatePrompt(
  deps: ToolDeps,
  args: { id: string; description?: string; body?: string; shared?: boolean },
): Promise<PromptWireRow> {
  const { id, ...patch } = args;
  return deps.api.req<PromptWireRow>(`/api/prompts/${encodeURIComponent(id)}`, { method: "PUT", body: patch });
}

/** `delete_prompt`: removes the row; there is no undo. */
export async function deletePrompt(deps: ToolDeps, args: { id: string }): Promise<{ ok: true }> {
  return deps.api.req<{ ok: true }>(`/api/prompts/${encodeURIComponent(args.id)}`, { method: "DELETE" });
}

// --- tool schemas (named constants per the code-style rule) ---

/** `list_prompts` takes nothing. */
export const ListPromptsToolSchema = z.object({});

/** `get_prompt` addresses one row by id. */
export const GetPromptToolSchema = z.object({ id: z.string().describe("Prompt id from list_prompts") });

/** `create_prompt`: description is the required label; shared defaults to none. */
export const CreatePromptToolSchema = z.object({
  description: z.string().min(1).max(120).describe("Short required label for the library"),
  body: z.string().min(1).max(20000).describe("The prompt text"),
  shared: z
    .boolean()
    .optional()
    .describe("Publish to every account on the instance (default false; leave false unless asked)"),
});

/** `update_prompt`: at least one field beside the id. */
export const UpdatePromptToolSchema = z
  .object({
    id: z.string().describe("Prompt id"),
    description: z.string().min(1).max(120).optional().describe("New short label"),
    body: z.string().min(1).max(20000).optional().describe("New prompt text"),
    shared: z.boolean().optional().describe("Set the everyone-or-none share (true publishes the text to the instance)"),
  })
  .refine((a) => a.description !== undefined || a.body !== undefined || a.shared !== undefined, {
    message: "Pass at least one of description, body, or shared",
  });

/** `delete_prompt`: one row, no undo. */
export const DeletePromptToolSchema = z.object({ id: z.string().describe("Prompt id to remove") });
