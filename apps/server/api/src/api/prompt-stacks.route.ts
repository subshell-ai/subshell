import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { PromptStacksRepository, StackMemberReferenceGone } from "@/db/repositories/prompt-stacks.repository.js";
import { PromptsRepository } from "@/db/repositories/prompts.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { PromptStackItemTable, PromptStackTable } from "@/db/types/prompt-stacks.db-types.js";
import type { PromptTable } from "@/db/types/prompts.db-types.js";

/**
 * Prompt stacks (spec 2026-09-29): ordered collections of saved prompts with a
 * short label, shared everyone-or-nobody exactly like single prompts. This
 * module is NOT mounted in `computeRoutes` - it folds into the already-mounted
 * prompts instance (`.use(promptStackRoutes)` inside `prompts.route.ts`), which
 * keeps the Elysia `App`-type depth budget untouched AND puts `/stacks` ahead
 * of the parent's `/:id` in the registration order so the static path wins.
 *
 * Two rules live here, both inherited from the design conversation:
 * - Deleting a prompt removes it from every stack. That is the FK CASCADE in
 *   migration 0042, not code; a stack is then EMPTY, which is a state.
 * - A referenced prompt the CALLER cannot see (someone else's, since unshared)
 *   is dropped from the view's items rather than answered about. The row stays;
 *   sharing it again returns the member.
 */

/** The create-prompt wire cap; a stack's joined text must fit the same field. */
const JOINED_PROMPT_CAP = 20000;
/** A list-editor bound; the joined cap is the real limit, this is the row sanity. */
const MAX_STACK_ITEMS = 50;

/** One visible member as any reader sees it. */
const StackItemViewSchema = t.Object({
  id: t.String({ description: "Item id (uuid)" }),
  promptId: t.Optional(t.String({ description: "Present on a reference member: the live prompt it points at" })),
  description: t.String({
    description: 'Reference member: the prompt\'s description. Inline member: its label ("" when none)',
  }),
  body: t.String({ description: "Reference member: the prompt's current text. Inline member: the stack's own text" }),
  ownerName: t.Optional(t.String({ description: "Present when this member is someone else's shared prompt" })),
});

const StackViewSchema = t.Object({
  id: t.String({ description: "Stack id (uuid)" }),
  label: t.String({ description: "Short required label" }),
  shared: t.Boolean({ description: "True when every account on the instance can read it" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  updatedAt: t.String({ description: "ISO 8601 last-update timestamp" }),
  items: t.Array(StackItemViewSchema, {
    description: "Members in launch order; a member the caller cannot see is simply absent",
  }),
});

const SharedStackViewSchema = t.Object({
  id: t.String({ description: "Stack id (uuid)" }),
  label: t.String({ description: "Short required label" }),
  ownerName: t.String({ description: "Display name (email when no name) of the stack's owner" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  updatedAt: t.String({ description: "ISO 8601 last-update timestamp" }),
  items: t.Array(StackItemViewSchema, { description: "Members the caller can see, in launch order" }),
});

const PromptStacksListSchema = t.Object({
  own: t.Array(StackViewSchema, { description: "The caller's own stacks (empty ones included), newest-updated first" }),
  shared: t.Array(SharedStackViewSchema, {
    description: "Other accounts' shared stacks, newest-updated first",
  }),
});

/** `GET /stacks/:id` answers either shape depending on ownership. */
const PromptStackDetailViewSchema = t.Object({
  id: t.String({ description: "Stack id (uuid)" }),
  label: t.String({ description: "Short required label" }),
  shared: t.Optional(t.Boolean({ description: "Present on the owner's own rows" })),
  ownerName: t.Optional(t.String({ description: "Present when the row belongs to someone else" })),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  updatedAt: t.String({ description: "ISO 8601 last-update timestamp" }),
  items: t.Array(StackItemViewSchema, { description: "Members the caller can see, in launch order" }),
});

const StackLabel = t.String({
  minLength: 1,
  maxLength: 120,
  description: "Short label, required (whitespace-only is refused)",
});

/**
 * One member from the wire: exactly one of `promptId` (reference the saved
 * prompt) or `body` (the stack's own inline text). The both/neither refusal
 * lives in the transform, the stray-key posture: Elysia strips silently, so
 * the schema alone cannot say "exactly one".
 */
const StackMemberInputSchema = t.Object({
  promptId: t.Optional(t.String({ minLength: 1, description: "Reference an existing prompt the caller can see" })),
  body: t.Optional(
    t.String({ minLength: 1, maxLength: JOINED_PROMPT_CAP, description: "Inline free text (no prompt row behind it)" }),
  ),
  description: t.Optional(t.String({ maxLength: 120, description: "Label for an inline member" })),
});

/** CREATE: a stack is born with at least one member (the editor adds rows). */
const CreateStackItemsSchema = t.Array(StackMemberInputSchema, {
  minItems: 1,
  maxItems: MAX_STACK_ITEMS,
  description: "Ordered members; each is exactly one of promptId or body",
});

/** UPDATE: the same members, and an explicit [] is a real answer (the stack empties). */
const UpdateStackItemsSchema = t.Array(StackMemberInputSchema, {
  maxItems: MAX_STACK_ITEMS,
  description: "Ordered members, FULL replace; each is exactly one of promptId or body, and [] empties the stack",
});

const CreateStackBodySchema = t.Object({
  label: StackLabel,
  items: CreateStackItemsSchema,
  shared: t.Optional(t.Boolean({ description: "Share with everyone at create (default false)" })),
});

/** Named key set, the prompts lesson: the honest stray-key 400 is a transform. */
const UpdateStackBodySchema = t.Object({
  label: t.Optional(StackLabel),
  items: t.Optional(UpdateStackItemsSchema),
  shared: t.Optional(t.Boolean({ description: "Flip the everyone-or-none share" })),
});

const UPDATE_STACK_KEYS = new Set(["label", "items", "shared"]);

/** Validated member, one shape into the repository. */
type MemberInput = { promptId: string | null; body: string | null; description: string | null };

/**
 * Resolve the wire items into repository members: each must be exactly one of
 * promptId/body, and every referenced prompt must be VISIBLE to the caller
 * (own or shared). The visible rows come back too - the caller needs their
 * bodies for the joined-text cap without re-reading.
 */
async function cleanMembers(
  items: { promptId?: string; body?: string; description?: string }[],
  userId: string,
): Promise<{ members: MemberInput[]; prompts: Map<string, PromptTable> }> {
  const MEMBER_RULE = "A stack member is exactly one of promptId (reference) or body (inline text)";
  const members: MemberInput[] = [];
  for (const item of items) {
    if (item.promptId !== undefined) {
      if (item.body !== undefined || item.description !== undefined)
        throw new PromptStackError("bad_request", MEMBER_RULE, 400);
      members.push({ promptId: item.promptId, body: null, description: null });
    } else if (item.body !== undefined) {
      const trimmed = item.description?.trim();
      members.push({ promptId: null, body: item.body, description: trimmed ? trimmed : null });
    } else {
      throw new PromptStackError("bad_request", MEMBER_RULE, 400);
    }
  }
  const refIds = [...new Set(members.flatMap((m) => (m.promptId ? [m.promptId] : [])))];
  const rows = await new PromptsRepository(db).listByIds(refIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const m of members) {
    if (!m.promptId) continue;
    const row = byId.get(m.promptId);
    if (!row || (row.userId !== userId && row.shared !== 1)) {
      throw new PromptStackError("bad_request", `Stack member references a prompt you cannot see: ${m.promptId}`, 400);
    }
  }
  return { members, prompts: byId };
}

/**
 * The save-time mirror of the launch wire: the members' text, joined as launch
 * joins it, must fit 20000. Callers hand the WHOLE set the save produces
 * (create: every member; update: the visible rewrite plus any preserved rows),
 * so a stack never saves under a text its own launch would refuse.
 */
function assertJoinedCap(members: readonly MemberInput[], prompts: ReadonlyMap<string, PromptTable>): void {
  const joined = members.map((m) => (m.promptId ? (prompts.get(m.promptId)?.body ?? "") : (m.body ?? ""))).join("\n\n");
  if (joined.length > JOINED_PROMPT_CAP) {
    throw new PromptStackError(
      "bad_request",
      `The stack's text joined is ${joined.length} characters; a prompt is typed into the pane as one string capped at ${JOINED_PROMPT_CAP}`,
      400,
    );
  }
}

function cleanLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new PromptStackError("bad_request", "A stack needs a non-empty label", 400);
  return trimmed;
}

/**
 * Whether a membership row names a prompt this caller cannot see (someone
 * else's, since unshared). The read drops such rows from every view, which is
 * why a save can never NAME them - and why the full-replace PUT preserves
 * them (below): invisible is not the same as absent, and "returns on re-share"
 * depends on the row still being there. Inline rows are always visible.
 */
function invisibleToCaller(
  item: PromptStackItemTable,
  prompts: ReadonlyMap<string, PromptTable>,
  userId: string,
): boolean {
  if (!item.promptId) return false;
  const prompt = prompts.get(item.promptId);
  return !prompt || (prompt.userId !== userId && prompt.shared !== 1);
}

/**
 * Build item views for one stack: ref members resolve through the batched
 * prompt map (INVISIBLE ONES ARE DROPPED - the view never answers "there was
 * something here"), inline members pass through.
 */
function itemViews(
  items: readonly PromptStackItemTable[],
  prompts: ReadonlyMap<string, PromptTable>,
  names: ReadonlyMap<string, string>,
  userId: string,
) {
  const views: { id: string; promptId?: string; description: string; body: string; ownerName?: string }[] = [];
  for (const item of items) {
    if (item.promptId) {
      const prompt = prompts.get(item.promptId);
      if (!prompt || (prompt.userId !== userId && prompt.shared !== 1)) continue;
      views.push({
        id: item.id,
        promptId: prompt.id,
        description: prompt.description,
        body: prompt.body,
        ownerName: prompt.userId === userId ? undefined : (names.get(prompt.userId) ?? prompt.userId),
      });
    } else {
      views.push({
        id: item.id,
        description: item.description ?? "",
        body: item.body ?? "",
      });
    }
  }
  return views;
}

/** One batched name map for stack owners AND foreign member-prompt owners. */
async function ownerNamesFor(
  stacks: readonly PromptStackTable[],
  items: readonly PromptStackItemTable[],
  prompts: ReadonlyMap<string, PromptTable>,
  userId: string,
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const s of stacks) if (s.userId !== userId) ids.add(s.userId);
  for (const item of items) {
    const prompt = item.promptId ? prompts.get(item.promptId) : undefined;
    if (prompt && prompt.userId !== userId) ids.add(prompt.userId);
  }
  return new UsersRepository(db).displayNamesByIds([...ids]);
}

// The `authGuard` use is for THIS module's type context (`user`, `actor`,
// `apiKeyPermissions` in the handlers); mounted via `.use(promptStackRoutes)`
// inside `prompts.route.ts`, the named instance dedupes to the parent's
// single use (the apiModels precedent) and the hooks are inherited anyway.
export const promptStackRoutes = new Elysia()
  .use(authGuard)
  .get(
    "/stacks",
    async ({ user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "prompts", "read");
      const repo = new PromptStacksRepository(db);
      const [own, shared] = await Promise.all([repo.listOwn(user.id), repo.listShared(user.id)]);
      const stacks = [...own, ...shared];
      const items = await repo.listItemsForStacks(stacks.map((s) => s.id));
      const refIds = [...new Set(items.flatMap((i) => (i.promptId ? [i.promptId] : [])))];
      const prompts = new Map((await new PromptsRepository(db).listByIds(refIds)).map((p) => [p.id, p]));
      const names = await ownerNamesFor(stacks, items, prompts, user.id);
      const byStack = new Map<string, PromptStackItemTable[]>();
      for (const item of items) {
        const list = byStack.get(item.stackId) ?? [];
        list.push(item);
        byStack.set(item.stackId, list);
      }
      const itemsFor = (id: string) => itemViews(byStack.get(id) ?? [], prompts, names, user.id);
      return {
        own: own.map((s) => ({
          id: s.id,
          label: s.label,
          shared: s.shared === 1,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          items: itemsFor(s.id),
        })),
        shared: shared.map((s) => ({
          id: s.id,
          label: s.label,
          ownerName: names.get(s.userId) ?? s.userId,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          items: itemsFor(s.id),
        })),
      };
    },
    {
      response: PromptStacksListSchema,
      detail: {
        operationId: "listPromptStacks",
        tags: ["prompts"],
        description:
          "Lists the caller's own stacks and the shared stacks of every other account, members in launch order; a member prompt the caller cannot see is dropped from the copy",
      },
    },
  )
  .get(
    "/stacks/:id",
    async ({ params, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "prompts", "read");
      const repo = new PromptStacksRepository(db);
      const row = await repo.findById(params.id);
      // Foreign AND absent answer the same 404, BEFORE any member work (the
      // ownership axis; a hidden row is not read at all).
      if (!row || (row.userId !== user.id && row.shared !== 1)) {
        throw new PromptStackError("not_found", "Prompt stack not found");
      }
      const items = await repo.listItems(row.id);
      const refIds = [...new Set(items.flatMap((i) => (i.promptId ? [i.promptId] : [])))];
      const prompts = new Map((await new PromptsRepository(db).listByIds(refIds)).map((p) => [p.id, p]));
      const names = await ownerNamesFor([row], items, prompts, user.id);
      const view = {
        id: row.id,
        label: row.label,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        items: itemViews(items, prompts, names, user.id),
      };
      // The owner sees their `shared` flag; a reader sees WHO shared it instead.
      return row.userId === user.id
        ? { ...view, shared: row.shared === 1 }
        : { ...view, ownerName: names.get(row.userId) ?? row.userId };
    },
    {
      params: t.Object({ id: t.String({ description: "Stack id" }) }),
      response: PromptStackDetailViewSchema,
      detail: {
        operationId: "getPromptStack",
        tags: ["prompts"],
        description:
          "Reads one stack by id with its visible members (own rows always; foreign rows only when shared; else 404)",
      },
    },
  )
  .post(
    "/stacks",
    async ({ body, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "prompts", "write");
      const { members, prompts } = await cleanMembers(body.items, user.id);
      assertJoinedCap(members, prompts);
      const label = cleanLabel(body.label);
      const repo = new PromptStacksRepository(db);
      // Stack + members land in ONE transaction, so a mid-create failure never
      // strands an empty stack row for the caller to trip over on retry. A
      // reference deleted since cleanMembers throws inside that transaction,
      // answered as the retryable 400 it is.
      let created: { stack: PromptStackTable; items: PromptStackItemTable[] };
      try {
        created = await repo.createWithItems(
          { id: crypto.randomUUID(), userId: user.id, label, shared: body.shared ? 1 : 0 },
          members,
        );
      } catch (err) {
        throw mapReferenceGone(err);
      }
      const row = created.stack;
      const items = created.items;
      const names = await ownerNamesFor([row], items, prompts, user.id);
      return {
        id: row.id,
        label: row.label,
        shared: row.shared === 1,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        items: itemViews(items, prompts, names, user.id),
      };
    },
    {
      body: CreateStackBodySchema,
      response: StackViewSchema,
      detail: {
        operationId: "createPromptStack",
        tags: ["prompts"],
        description: "Creates a stack owned by the caller from an ordered member list",
      },
    },
  )
  .put(
    "/stacks/:id",
    async ({ params, body, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "prompts", "write");
      const repo = new PromptStacksRepository(db);
      const existing = await repo.findById(params.id);
      // Foreign AND absent answer the same 404 (the ownership axis).
      if (!existing || existing.userId !== user.id) throw new PromptStackError("not_found", "Prompt stack not found");
      if (body.label === undefined && body.items === undefined && body.shared === undefined) {
        throw new PromptStackError("bad_request", "The update body names no field to change", 400);
      }
      // items is a FULL ordered replace when present (never a merge); an
      // explicit [] empties the stack, which the lifecycle allows. What the
      // caller could not SEE, the caller could not NAME - so member rows
      // pointing at prompts now invisible to them are PRESERVED through the
      // rewrite (landed behind the new set): saving the visible half must not
      // silently destroy the invisible half, and the re-share rule has
      // nothing to bring back once the row is gone.
      const before = await repo.listItems(params.id);
      const beforeRefIds = [...new Set(before.flatMap((i) => (i.promptId ? [i.promptId] : [])))];
      const beforePrompts = new Map((await new PromptsRepository(db).listByIds(beforeRefIds)).map((p) => [p.id, p]));
      const preserved = before.filter((i) => invisibleToCaller(i, beforePrompts, user.id));
      // Validate the label BEFORE any write. A whitespace-only label clears
      // the schema (minLength passes "   ") and fails only in cleanLabel, so
      // computing it after the member rewrite would save the members and
      // THEN 400 - the dialog shows an error while the stack actually changed.
      const label = body.label !== undefined ? cleanLabel(body.label) : existing.label;
      const shared = body.shared !== undefined ? (body.shared ? 1 : 0) : existing.shared;
      let items: PromptStackItemTable[];
      let prompts: Map<string, PromptTable>;
      let row: PromptStackTable;
      if (body.items !== undefined) {
        const cleaned = await cleanMembers(body.items, user.id);
        // Cap the FULL set this save produces: the newly-named visible members
        // PLUS the invisible rows preserved behind them. Launch types every
        // member - visible or not - so the save must measure what launch will
        // send, or the 20000 wire rule would only bite at launch time.
        const preservedMembers: MemberInput[] = preserved.map((kept) => ({
          promptId: kept.promptId ?? null,
          body: kept.body ?? null,
          description: kept.description ?? null,
        }));
        assertJoinedCap([...cleaned.members, ...preservedMembers], new Map([...beforePrompts, ...cleaned.prompts]));
        // ONE transaction: the reference re-check, the member rewrite and the
        // row patch. A split save could commit the members and then fail the
        // label, answering an error over a half-changed stack.
        try {
          const saved = await repo.updateWithItems(params.id, { label, shared }, cleaned.members, preserved);
          row = saved.stack;
          items = saved.items;
        } catch (err) {
          throw mapReferenceGone(err);
        }
        prompts = cleaned.prompts;
      } else {
        items = before;
        prompts = beforePrompts;
        const updated = await repo.update(params.id, { label, shared });
        if (!updated) throw new PromptStackError("not_found", "Prompt stack not found");
        row = updated;
      }
      const names = await ownerNamesFor([row], items, prompts, user.id);
      return {
        id: row.id,
        label: row.label,
        shared: row.shared === 1,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        items: itemViews(items, prompts, names, user.id),
      };
    },
    {
      params: t.Object({ id: t.String({ description: "Stack id" }) }),
      transform({ body }) {
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
          const stray = Object.keys(body).find((key) => !UPDATE_STACK_KEYS.has(key));
          if (stray !== undefined) {
            throw new PromptStackError("bad_request", `Unknown property in prompt stack update body: ${stray}`, 400);
          }
        }
      },
      body: UpdateStackBodySchema,
      response: StackViewSchema,
      detail: {
        operationId: "updatePromptStack",
        tags: ["prompts"],
        description:
          "Applies a partial update (label, full ordered items replace, shared) to a stack owned by the caller; a patch naming no field is a 400",
      },
    },
  )
  .delete(
    "/stacks/:id",
    async ({ params, user, actor, apiKeyPermissions }) => {
      requirePerm({ actor, apiKeyPermissions }, "prompts", "write");
      const repo = new PromptStacksRepository(db);
      const existing = await repo.findById(params.id);
      if (!existing || existing.userId !== user.id) throw new PromptStackError("not_found", "Prompt stack not found");
      await repo.delete(params.id);
      return { ok: true };
    },
    {
      params: t.Object({ id: t.String({ description: "Stack id" }) }),
      response: t.Object({ ok: t.Boolean({ description: "True when the stack was deleted" }) }),
      detail: {
        operationId: "deletePromptStack",
        tags: ["prompts"],
        description: "Deletes a stack owned by the caller; its member PROMPTS survive (only membership is removed)",
      },
    },
  );

/** Route error with an HTTP status; the prompts/presets local-class posture. */
class PromptStackError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 404) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * A reference deleted between the visibility read and the write transaction:
 * the row vanished under a save that had every right to start, so it is a
 * retryable 400 naming what to do - never the FK's status-less 500, which the
 * handler could only answer as an internal error. Other errors ride on.
 */
function mapReferenceGone(err: unknown): unknown {
  if (err instanceof StackMemberReferenceGone) {
    return new PromptStackError(
      "bad_request",
      "A member references a prompt that was just deleted. Save again with the current list.",
      400,
    );
  }
  return err;
}
