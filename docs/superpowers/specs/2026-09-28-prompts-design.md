# Prompts: a saved-prompt library for launching and injecting

Date: 2026-09-28. Status: approved (operator delegated the remaining calls).

## Summary

A new first-class resource, **Prompts**: short-description + text-body snippets a
user saves, shares with everyone or nobody, browses on a new page, picks when
creating a subshell, and injects into a running pane. Panes get full CRUD over
MCP. It is the presets pattern (per-user saved entity) crossed with the shares
pattern's "Everyone" idea, deliberately simplified to a boolean.

## Decisions from the dialogue

1. **Inject means typed, never submitted.** Selecting a prompt for a running
   pane types it into the pane and stops. The user reviews and presses Enter.
   A submitted line can corrupt a mid-turn harness (same reasoning as the
   nudge two-tier rule, `docs/security.md` §7).
2. **Create dialog: a stack of blocks.** Picked prompts (and optional custom
   free text) are discrete, reorderable rows; at launch they are joined with a
   blank line between into the one `prompt` the create body already carries.
3. **Scope:** web SPA + server + MCP. Mobile is out. Desktop picks the page up
   for free (remote window renders the SPA).
4. **MCP surface is full CRUD** including the `shared` toggle (operator ruling;
   I flagged the disclosure argument and the ruling stands: the instance is
   trusted-network and single-user by posture, the pane token already acts as
   its owner across many surfaces, and "shared" only reaches accounts the
   operator already chose to admit).
5. **Storage is the simple shape:** one `prompts` table with a `shared`
   boolean, not a `prompt_shares` table. "Everyone or none" is the whole rule;
   a future named-grantee model grows a table then, and the API's `shared`
   field can survive that swap.

## Data model

Migration `0041-prompts.ts`, table `prompts`:

| column | type | notes |
| --- | --- | --- |
| `id` | text pk | uuid |
| `user_id` | text, FK `user.id` cascade | owner |
| `description` | text, not null | required, trimmed, max 120 (rename cap) |
| `body` | text, not null | 1..20000 chars, exactly the create-prompt wire cap |
| `shared` | integer 0/1, default 0 | the everyone-or-none flag |
| `created_at` / `updated_at` | text | the ISO-format convention (`strftime('%Y-%m-%dT%H:%M:%fZ','now')` on update, per the 2026-09-14 workspaces bug note) |

Index on `(user_id, shared)`. No uniqueness on description. Type file
`db/types/prompts.db-types.ts` (`PromptTable`, `NewPrompt`, `PromptUpdate`),
registered in `db/types/index.ts`; module added to the `Migrator` map in
`db/migrate.ts`. Repository `PromptsRepository extends BaseRepository`:
`create`, `findById`, `listOwn(userId)`, `listShared(excludingUserId)`,
`update`, `delete`. `listShared` joins the `user` table for the owner label
(`name` when present, else `email`), surfaced as `ownerName`.

## Server API

Single flat module `api/prompts.route.ts` (the `presets.route.ts` shape),
prefix `/api/prompts`, `.use(authGuard)`, mounted in `computeRoutes` beside
`presetRoutes` (the depth-budget rule in `routes.ts`; presets proves a flat
module mounts fine there).

- `GET /api/prompts` → `{ own: PromptView[], shared: SharedPromptView[] }`,
  ordered newest-updated. Available to every authenticated actor; a bearer
  sees its owner's rows. Shared rows carry `ownerName`; own rows carry
  `shared`.
- `POST /api/prompts` `{ description, body, shared? }` → 200 view (Elysia's POST default, the presets precedent).
- `PUT /api/prompts/:id` partial `{ description?, body?, shared? }` → view; a patch naming NO field is a 400.
  Stray keys refused in the route `transform`, the presets posture (Elysia
  strips silently, so the transform is the enforcement, not the schema).
- `DELETE /api/prompts/:id` → `{ ok: true }`.

Authz: a foreign (or own, after delete) id on `/:id` paths is **404, never
403**, matching the ownership axis. Reads require `requirePerm(ctx, "prompts",
"read")`, writes `"write"`. `requirePerm`'s resource union grows `"prompts"`.

Token scopes: `subshell-tokens.ts` issues `prompts: ["read", "write"]`
alongside channels/subshells. Tokens minted before this feature carry no
`prompts` key at all; `requirePerm` treats **a missing `prompts` key as
granted** (absence proves the map predates the feature, since every map
minted after carries the key). New tokens are gated normally; self-extending
legacy panes keep working without a restart. Document this inline; it is the
one backward-compat concession.

No audit rows (presets, channels, and shares write none; the `shared` flag
rides every read, so a flip is visible). No live events; surfaces re-fetch on
dialog close. No server-side search or pagination: small per-user lists, the
accepted posture.

Validation: description required non-empty after trim, ≤120; body required
non-empty, ≤20000; both enforced by Elysia `t` schemas with `description`
fields on every property (code-style rule).

## MCP tools

`packages/mcp-core`: a new `prompt-tools.ts` (the split that keeps
`subshell-tools.ts` focused), registered in `server.ts`'s `registerTools`:

- `list_prompts` → own + shared, `{id, description, shared, ownerName?, updatedAt}` + one-line body preview
- `get_prompt` `{id}` → full row
- `create_prompt` `{description, body, shared?}`
- `update_prompt` `{id, ...}` (partial)
- `delete_prompt` `{id}`

All ride `deps.api.req` at the same altitude as the sibling tools; errors map
through `describeToolError`. Zod schemas as named constants (the code-style
rule; `server.ts`'s inline divergence is not precedent).

## Prompts page (SPA)

New route `routes/prompts.tsx`, sidebar entry beside Presets in
`sidebar-nav.ts` (`to: "/prompts"`, label Prompts). Composition mirrors the
presets/nodes pages:

- **Tabs:** `Segmented` own / shared keyed in the URL (`?tab=own|shared`,
  own on absence, nodes-page pattern) with count badges.
- **Filter:** one search input; client-side, case-insensitive, matches
  description or body. Empty states distinguish "no prompts yet" from "no
  matches".
- **Rows:** description in `label` weight over a one-line body preview +
  `updated` stamp in `detail`/muted. Shared tab shows `ownerName` instead of
  share controls.
- **Expand:** clicking the row toggles an inline full-body block
  (`aria-expanded`, local state, the node-row precedent), `whitespace-pre-wrap`,
  with a copy button.
- **Row actions menu** (`ActionItem[]` + `ActionMenu`, `confirmAction` for
  remove): **Copy** (body to clipboard), **Edit…**, **Clone** (add dialog
  prefilled, description `Copy of ...`, presets-style suggestion), **Share
  with everyone** ⇄ **Stop sharing** (owner rows only), **Remove**.
- **Add prompt** button → dialog: description input (required, inline
  validation), body textarea, **Share with everyone** switch (off default).
  Same dialog serves Edit.

Hooks: `use-prompts.ts` (`usePrompts()` one query key `["prompts"]`,
mutations invalidate it). Types in `lib/prompts.ts` shared with the dialogs.

## Create-dialog prompt stack

All in `new-subshell-form.tsx`, so every launch surface inherits it. `
NewSubshellFormValue` grows `promptBlocks: PromptBlock[]`
(`{ localId, kind: "saved" | "custom", promptId?, description, body }`), fresh
on every open including clone.

- **Collapsed:** one checkbox row, "Add a prompt", under the working dir.
  Untouched, nothing below it renders and nothing extra is sent.
- **Expanded:** the block rows (description as `label`, truncated body as
  `detail`, up/down/remove icon buttons; no drag dependency), then a
  "+ Add prompt" button that opens the **picker** (inline, amended
  2026-09-29).
- **Picker** (`components/prompts/prompt-picker-body.tsx`, ONE component
  in two surfaces, amended 2026-09-29 after dialog-on-dialog proved
  unwieldy): the searchable dropdown (description + body matching,
  one-line preview per row), own/shared `Segmented`, and a dashed
  **"Write your own..."** button under the list that swaps to a textarea
  with a "Save to my prompts" switch (off) plus its description field.
  The launch form renders the body INLINE (it replaces the "Add prompt"
  button while open; a pick lands the block and collapses back to the
  button); the inject action puts the same body on a Dialog, where a pick
  advances to the confirm step by unmount swap. The body closes nothing
  itself - it reports picks and exits.
- **Launch:** `toSubshellCreateBody` adds `prompt` = blocks joined with
  `"\n\n"`, only when the stack is non-empty and the section is on. The
  server types it once the harness settles (existing seam).
- If the response carries `promptDelivered: false`, the success toast says the
  subshell started but the prompt did not land, pointing at Inject prompt.
- Pure join/reorder logic lives in `lib/prompt-stack.ts` with tests.

## Inject action on a subshell

`subshell-actions-menu.tsx` gains **"Inject prompt..."**: gated like terminal
input (`access !== "view"` and the row running; hidden otherwise). Opens
`components/prompts/inject-prompt-dialog.tsx`: the picker in single-select
(including Write-your-own), then a confirm step showing the full text, one
sentence of help ("This types into the pane without sending."), and a **Type
into pane** button that POSTs `/api/subshells/:id/input` `{ text, submit:
false }`. It is the first UI consumer of that route. Refusals (dead row 409,
node offline) render inline in the dialog and keep it open: failures land on
the thing that failed.

## Error handling

- Page/dialog mutations surface `ApiError.message` inline under the control;
  list errors show the pages' existing error affordance.
- Server: schema validation 400s (with the field named), foreign/delete-absent
  404, permission-map 403 from `requirePerm`, running-state refusals live in
  the existing input route untouched.
- Clipboard copy failure is silent-but-honest: the copy button shows a brief
  "Copied" confirmation only on success.

## Testing

- Migration test (`migrations/__tests__/`): up/down, index exists.
- Repository tests: listOwn/listShared scoping (own never appears in shared,
  unshared invisible to others), ownerName fallback to email.
- Route tests `api/__tests__/prompts.route.test.ts`: CRUD happy path; trim and
  length validation; PUT stray-key refusal; foreign id 404 on PUT/DELETE;
  shared visibility across two users; bearer read/write gated by the prompts
  scope, legacy map (no `prompts` key) passes, explicit `prompts: ["read"]`
  refuses writes; cookie path unaffected.
- MCP tool tests in `packages/mcp-core/src/__tests__/` against the stub
  `ToolApi`: each tool's path, body shape, and error mapping.
- Web: `lib/prompt-stack.test.ts` (join, reorder, remove); picker filter and
  own/shared tab logic as pure helpers with tests; the create body includes
  `prompt` only when the section is on and non-empty.

## Out of scope

Mobile UI; named-user shares; prompt variables/templating; audit trail rows;
MCP prompt recommendations or auto-injection; changing the create/restart
prompt delivery seam itself.

## Amendment (2026-09-29, operator live-testing)

Rulings from testing the branch over plain http on the LAN, in order:

- The picker's search IS the shared searchable dropdown (combobox),
  filtering description OR body; the page's empty sentences ride its
  empty state, the failure one staying destructive.
- A pick is ONE decisive action: the picker leaves after it. In the
  inject flow it ADVANCED to the confirm step by absorbing the pick's
  dialog-close (a menu-driven close would have unmounted the pick).
  Superseded the same day by the inline ruling below: the body now
  reports picks and never closes anything itself, and each surface
  decides (launch collapses back to the button, inject swaps to the
  confirm) - which retired the absorption hack.
- The stacked block shows its full text COLLAPSED by default, one click
  to read (the page row's shape).
- "Write your own..." keeps its draft in sessionStorage until it is
  SUBMITTED: a refresh mid-edit reopens the step with the text intact;
  submitting spends the draft.
- The picker is ONE body in two surfaces (dialog-on-dialog-on-dialog
  read as unwieldy): INLINE in the launch form (it replaces the "Add
  prompt" button while open), and the same body on a Dialog for the
  inject action. `loadDraft` also rejects a stored empty body, so a
  stale draft can never reopen the picker at an empty editor.
- Non-secure origins matter: `crypto.randomUUID` is absent over plain
  http on a LAN address, and a click handler that assumes it reads as a
  dead control. Stack ids come from `newPromptLocalId`, which falls back.
