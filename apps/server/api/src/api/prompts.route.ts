import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { PromptsRepository } from "@/db/repositories/prompts.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { PromptTable } from "@/db/types/prompts.db-types.js";

/**
 * Saved prompts (spec 2026-09-28): a per-user library of reusable text with a
 * required short description, shared with EVERYONE or nobody via a boolean.
 * The shape follows `presets.route.ts` (a flat module, a local error class)
 * and mounts in `computeRoutes` beside it for the depth-budget reason named
 * in `routes.ts`.
 *
 * Unlike presets, WRITES are open to bearer actors: a prompt body is plain
 * text with no credential layer (preset.env OUTRANKS the SUBSHELL_* launch
 * env; nothing like that exists here), and the operator ruling 2026-09-28
 * gave panes full CRUD, the share flip included. The disclosure widening a
 * `shared: true` write performs reaches only accounts the operator already
 * admitted to a trusted-network instance (spec §Decisions 4). The ownership
 * axis is the same as everywhere else: a foreign row is 404, never 403.
 */

/** One saved prompt as the owner sees it. */
const PromptViewSchema = t.Object({
  id: t.String({ description: "Prompt id (uuid)" }),
  description: t.String({ description: "Short required label" }),
  body: t.String({ description: "The prompt text" }),
  shared: t.Boolean({ description: "True when every account on the instance can read it" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  updatedAt: t.String({ description: "ISO 8601 last-update timestamp" }),
});

/** One saved prompt as a reader who does not own it sees it. */
const SharedPromptViewSchema = t.Object({
  id: t.String({ description: "Prompt id (uuid)" }),
  description: t.String({ description: "Short required label" }),
  body: t.String({ description: "The prompt text" }),
  ownerName: t.String({ description: "Display name (email when no name) of the prompt's owner" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  updatedAt: t.String({ description: "ISO 8601 last-update timestamp" }),
});

/** `GET /:id` answers either shape depending on ownership. */
const PromptDetailViewSchema = t.Object({
  id: t.String({ description: "Prompt id (uuid)" }),
  description: t.String({ description: "Short required label" }),
  body: t.String({ description: "The prompt text" }),
  shared: t.Optional(t.Boolean({ description: "Present on the owner's own rows" })),
  ownerName: t.Optional(t.String({ description: "Present when the row belongs to someone else" })),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  updatedAt: t.String({ description: "ISO 8601 last-update timestamp" }),
});

/** Description and body caps mirror the rename cap and the create-prompt wire. */
const PromptDescription = t.String({
  minLength: 1,
  maxLength: 120,
  description: "Short label, required (whitespace-only is refused)",
});
const PromptBody = t.String({
  minLength: 1,
  maxLength: 20000,
  description: "The prompt text (same 20000 cap as the create/restart prompt)",
});

const CreatePromptBodySchema = t.Object({
  description: PromptDescription,
  body: PromptBody,
  shared: t.Optional(t.Boolean({ description: "Share with everyone at create (default false)" })),
});

/**
 * `PUT /:id` body, deliberately a named key set rather than a Partial: the
 * presets lesson is that Elysia STRIPS unknown keys silently (1.4.29), so the
 * honest refusal of a key this route cannot apply lives in the transform
 * below, not in `additionalProperties`.
 */
const UpdatePromptBodySchema = t.Object({
  description: t.Optional(PromptDescription),
  body: t.Optional(PromptBody),
  shared: t.Optional(t.Boolean({ description: "Flip the everyone-or-none share" })),
});

const UPDATE_PROMPT_KEYS = new Set(["description", "body", "shared"]);

const PromptsListSchema = t.Object({
  own: t.Array(PromptViewSchema, { description: "The caller's own prompts, newest-updated first" }),
  shared: t.Array(SharedPromptViewSchema, {
    description: "Other accounts' prompts shared with everyone, newest-updated first",
  }),
});

function toView(row: PromptTable) {
  return {
    id: row.id,
    description: row.description,
    body: row.body,
    shared: row.shared === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A whitespace-only description passes `minLength: 1` but names nothing. */
function cleanDescription(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new PromptError("bad_request", "A prompt needs a non-empty description", 400);
  return trimmed;
}

export const promptsRoutes = new Elysia({ prefix: "/api/prompts" })
  .use(authGuard)
  .get(
    "/",
    async ({ user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "prompts", "read");
      const repo = new PromptsRepository(db);
      const [own, shared] = await Promise.all([repo.listOwn(user.id), repo.listShared(user.id)]);
      const users = new UsersRepository(db);
      const names = await users.displayNamesByIds([...new Set(shared.map((r) => r.userId))]);
      return {
        own: own.map(toView),
        shared: shared.map((r) => ({
          id: r.id,
          description: r.description,
          body: r.body,
          ownerName: names.get(r.userId) ?? r.userId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      };
    },
    {
      response: PromptsListSchema,
      detail: {
        operationId: "listPrompts",
        tags: ["prompts"],
        description: "Lists the caller's own prompts and the shared prompts of every other account",
      },
    },
  )
  .get(
    "/:id",
    async ({ params, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "prompts", "read");
      const repo = new PromptsRepository(db);
      const row = await repo.findById(params.id);
      if (!row) throw new PromptError("not_found", "Prompt not found");
      if (row.userId === user.id) return toView(row);
      if (row.shared !== 1) throw new PromptError("not_found", "Prompt not found");
      const names = await new UsersRepository(db).displayNamesByIds([row.userId]);
      return {
        id: row.id,
        description: row.description,
        body: row.body,
        ownerName: names.get(row.userId) ?? row.userId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },
    {
      params: t.Object({ id: t.String({ description: "Prompt id" }) }),
      response: PromptDetailViewSchema,
      detail: {
        operationId: "getPrompt",
        tags: ["prompts"],
        description: "Reads one prompt by id (own rows always; foreign rows only when shared; else 404)",
      },
    },
  )
  .post(
    "/",
    async ({ body, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "prompts", "write");
      const repo = new PromptsRepository(db);
      const row = await repo.create({
        id: crypto.randomUUID(),
        userId: user.id,
        description: cleanDescription(body.description),
        body: body.body,
        shared: body.shared ? 1 : 0,
      });
      return toView(row);
    },
    {
      body: CreatePromptBodySchema,
      response: PromptViewSchema,
      detail: {
        operationId: "createPrompt",
        tags: ["prompts"],
        description: "Creates a prompt owned by the caller",
      },
    },
  )
  .put(
    "/:id",
    async ({ params, body, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "prompts", "write");
      const repo = new PromptsRepository(db);
      const existing = await repo.findById(params.id);
      // Foreign AND absent answer the same 404: the id is not an existence
      // oracle (the ownership axis, docs/security.md §3).
      if (!existing || existing.userId !== user.id) throw new PromptError("not_found", "Prompt not found");
      const row = await repo.update(params.id, {
        description: body.description !== undefined ? cleanDescription(body.description) : existing.description,
        body: body.body ?? existing.body,
        shared: body.shared !== undefined ? (body.shared ? 1 : 0) : existing.shared,
      });
      if (!row) throw new PromptError("not_found", "Prompt not found");
      return toView(row);
    },
    {
      params: t.Object({ id: t.String({ description: "Prompt id" }) }),
      transform({ body }) {
        // Same enforcement reason as the presets twin: Elysia would strip the
        // stray key and answer 200 having applied nothing.
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
          const stray = Object.keys(body).find((key) => !UPDATE_PROMPT_KEYS.has(key));
          if (stray !== undefined) {
            throw new PromptError("bad_request", `Unknown property in prompt update body: ${stray}`, 400);
          }
        }
      },
      body: UpdatePromptBodySchema,
      response: PromptViewSchema,
      detail: {
        operationId: "updatePrompt",
        tags: ["prompts"],
        description: "Applies a partial update (description, body, shared) to a prompt owned by the caller",
      },
    },
  )
  .delete(
    "/:id",
    async ({ params, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "prompts", "write");
      const repo = new PromptsRepository(db);
      const existing = await repo.findById(params.id);
      if (!existing || existing.userId !== user.id) throw new PromptError("not_found", "Prompt not found");
      await repo.delete(params.id);
      return { ok: true };
    },
    {
      params: t.Object({ id: t.String({ description: "Prompt id" }) }),
      response: t.Object({ ok: t.Boolean({ description: "True when the prompt was deleted" }) }),
      detail: {
        operationId: "deletePrompt",
        tags: ["prompts"],
        description: "Deletes a prompt owned by the caller",
      },
    },
  );

/** Route error with an HTTP status; Elysia maps `status` (the presets shape). */
class PromptError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 404) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
