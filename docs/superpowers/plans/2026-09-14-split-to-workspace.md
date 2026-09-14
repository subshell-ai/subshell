# Split a subshell into a workspace — Implementation Plan (2026-09-14)

Spec: `docs/superpowers/specs/2026-09-14-split-to-workspace-design.md`. Branch: `feat/split-to-workspace`.

## Tasks

Conventions for every task: `bun test` in the touched package, then the full gate
(`bun run verify-types && bun run lint:check && bun run test`) before reporting; TDD where a
pure function or route is involved; every `t` schema property carries a `description`; JSDoc
on new exports; no `await import`. Commit per task with a conventional message.

### Task A — migration + db types + repositories (API)
Files: `apps/server/api/src/db/migrations/0029-workspace-drafts.ts` (+ `__tests__/0029-workspace-drafts.test.ts`, chain `0001 → 0003 → 0006 → 0010 → 0017 → 0019 → 0029` as `0028`'s test does), `db/migrate.ts` (map entry), `db/types/workspaces.db-types.ts`, `db/repositories/workspaces.repository.ts` (`listByUser(userId, { includeDrafts = false })`, new `listBySubshellForUser(userId, subshellId)` joining `workspace_panes`), `db/repositories/workspace-panes.repository.ts` (unchanged unless `countForWorkspace` suffices — it does).
Tests: two drafts with the same name for one user insert; two saved with the same name fail `UNIQUE`; a draft and a saved with the same name coexist; `down` restores the full index.

### Task B — service + routes + schema (API)
Files: `services/workspaces.service.ts` (`createWorkspace({ userId, name, draft, subshellId })` with compensating delete; `listWorkspaces(userId, { subshellId? })`; `updateWorkspace` accepting `draft: false` → `{ draft: 0 }`; `removeWorkspacePane` returning `{ ok, workspaceDeleted }` with the <2-panes rule for drafts; `toWorkspaceResponse` adds `draft`), `api/models.ts` (`WorkspaceSchema.draft`), `api/workspaces/create-workspace.route.ts`, `list-workspaces.route.ts` (query schema), `update-workspace.route.ts`, `remove-workspace-pane.route.ts` (response schema).
Tests (`api/workspaces/__tests__/workspaces-route.test.ts`): draft excluded from list; `?subshellId=` returns drafts + saved for the caller and nothing for another user; create-with-subshellId makes the pane and 404s (no workspace row left) for a foreign subshell; promotion flips `draft` and 409s on a name the caller already saved; removing a pane from a two-pane draft deletes the draft and reports `workspaceDeleted: true`; same on a saved workspace leaves it with one pane and `false`.
Then `turbo build` so `backend-client` sees the new shapes.

### Task C — SPA: split intent + draft plumbing in the workspace page
Files: `types/workspace.ts` (`draft`, `SPLIT_DIRECTIONS`), `lib/workspace-split-intent.ts` + `lib/__tests__/workspace-split-intent.test.ts`, `routes/workspaces_.$id.tsx` (`validateSearch`, intent pass-through, auto-discard rule), `hooks/use-workspace-pane-mutations.ts` (`removePane` → `{ workspaceDeleted }`), `components/workspace-dock.tsx` (`ready` state, intent effect, `onRefetch: () => Promise<void>`, `workspaceDeleted` handling in `handleRemovePane`), `components/workspace-tabs.tsx` (same two behaviours).
Reuse: `handleAdd`, `resolveAddPosition` (`lib/workspace-layout.ts`), `isAlreadyGone` (`lib/api.ts`).

### Task D — SPA: draft header, save dialog, discard
Files: `components/workspace-header.tsx` (draft branch), new `components/save-workspace-dialog.tsx` (pattern: `components/sidebar/new-workspace-dialog.tsx` for Dialog + error handling; `EditableText`'s 409 relabel for the message), Discard via `confirmAction` (`lib/confirm.ts`). Design-system rules: type roles only (`text-label`, `text-detail`), token colours, 4px grid; run `bun run lint:design`.

### Task E — SPA: Split button on the subshell page + workspace link
Files: `components/subshell-picker/add-subshell-dialog.tsx` (`excludeSubshellIds`, `initialForm`), `components/subshell-picker.tsx` (map `existing` → ids), new `components/split-subshell-button.tsx`, new `hooks/use-subshell-workspaces.ts`, new `components/subshell-workspace-link.tsx`, `routes/subshells_.$id.tsx` (mount both in the header actions; keep the route thin). `SubshellView` already carries `harnessId`, `nodeId`, `workingDir`, `name`.

### Task F — docs, changeset, e2e
- Commit the spec and plan files named at the top (Fable does this before Task A).
- `apps/server/web/AGENTS.md`: "Drafts and the split flow" subsection (intent params, auto-discard rule and its intent guard, why the list excludes drafts). `apps/server/api/AGENTS.md`: one paragraph under workspaces.
- `bunx changeset` → `@internal/server` minor: "Split a running subshell into a workspace; unsaved workspaces are drafts you can name later." (Never a changeset for `@internal/server-web`.)
- `e2e/tests/06-split-to-workspace.spec.ts`: open a subshell, Split → New → launch, land on `/workspaces/:id` with two panes and the header reading "Unsaved workspace", Save workspace… → name appears on `/workspaces`. Run locally with `bun run test:e2e` (not part of `bun run test`).

Dependency order: A → B → (C ∥ D ∥ E, each after B's `turbo build`) → F. C/D/E touch disjoint files except `routes/subshells_.$id.tsx` (E only) and `workspace-header.tsx` (D only).

---

## Verification (end-to-end)

1. Gate: `bun run verify-types && bun run lint:check && bun run lint:design && bun run test`.
2. `turbo build` (Eden types), then `bun run test:e2e` for the new spec (needs tmux + Playwright chromium).
3. Manual, against `e2e/stack.ts` or a dev server on a temp DB — never `:3080`:
   - Split from a subshell → lands on the dock with the new pane at the chosen side; URL has no `add`/`dir` after load; reloading adds no duplicate pane.
   - Header shows "Unsaved workspace", Save/Discard; `/workspaces` and sidebar show nothing until Save; after Save the name appears in both.
   - Close one of two panes in a draft → back on the remaining subshell's page, draft gone (`GET /api/workspaces?subshellId=` empty).
   - Delete a subshell from a two-pane draft → same outcome via the auto-discard rule.
   - Below 1024 px the split lands as a tab.
   - Standing dockview probe from `apps/server/web/AGENTS.md`: zero new WebSockets when moving a pane.
