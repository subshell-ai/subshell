# Preset swap on an existing subshell — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Switch preset…" action-menu item on a subshell opens a dialog ("Switch and restart" confirm) that points `subshells.presetId` at another preset of the same harness (or none) and restarts the pane with it.

**Architecture:** No new route. `POST /api/subshells/:id/restart` gains an optional `{ presetId: string | null }` body; the service validates it (caller-owned, same-harness) after the existing edit gate and refusals; the manager writes the column inside the restart pipeline after the kill — before `#reviveRow`'s fresh re-read at `subshell-manager.service.ts:1050`, the line the code already calls the swap point. Refusals before the swap point (gate, validation, maintenance, offline pre-gate, and an alive row's failed kill) write nothing; a revive that throws after the swap leaves the row dead keeping the chosen preset (spec §2). Web: one dialog component owned by `SubshellActionsMenu` (which already owns every menu dialog), reusing the launch form's `Select` grammar.

**Tech Stack:** Bun + Elysia (`t` schemas), Kysely, TanStack Query + Base UI Select (React 19), `bun test` on both sides.

**Spec:** `docs/superpowers/specs/2026-09-23-preset-swap-design.md` — read it before any task; §-references below are its sections.

## Global Constraints

- **Pinned versions / no new dependencies.** No `package.json` change except the changeset (Task 4).
- **No dynamic imports** (`.claude/rules/code-style.md`); static top-level imports only.
- **Every Elysia `t` property carries a `description`** (`.claude/rules/code-style.md`). Expected 4xx are thrown with `throwApiError({ …, doNotLog: true })` and mapped in the route's `response` — the uploads-route pattern.
- **The announce rule** (`apps/server/api/AGENTS.md`): the swap rides the restart pipeline's existing `publishLive`; do not add a second one.
- **Design system** (`.claude/rules/design-system.md`): role classes only (`text-label font-strong`, `text-detail`, …), shadcn colour names, `bun run lint:design` must stay green. **UI copy: at most two sentences, no em dashes.**
- **Verification after every task:** `bun run verify-types`, `bun run lint:check`, `bun run test` (root or the touched package), plus `bunx turbo build` after Task 1 (a `packages/` change; `.claude/rules/build.md`).
- **Route tests must not assume an empty DB** (test-preload shares one per-process file); use `src/api/__tests__/helpers/auth-tables.ts` for authed cookie requests.
- **Commit style:** repo convention (`feat(server,server-web): …`), one commit per task.

---

## Task 1: The `INVALID_PRESET` error code

**Files:**
- Modify: `packages/backend-errors/src/error-codes.ts`

**Interfaces:**
- Produces: `BackendErrorCodes.INVALID_PRESET` (400) — consumed by Task 2's validation.

- [ ] **Step 1: Add the enum member + default.** In `error-codes.ts`, beside `INPUT_VALIDATION_ERROR` keep alphabetical-ish placement of the existing list; add to the `BackendErrorCodes` enum with a doc comment naming the surface (the file's style — every named code says which route raises it):

```ts
  /** `POST /api/subshells/:id/restart` with a `presetId`: the preset is unknown, not the caller's, or belongs to a different harness. Nothing was written and no restart was attempted. */
  INVALID_PRESET = "INVALID_PRESET",
```

and in the defaults map (the `[BackendErrorCodes.X]: { message, statusCode }` object):

```ts
  [BackendErrorCodes.INVALID_PRESET]: {
    message: "Invalid preset",
    statusCode: 400,
  },
```

- [ ] **Step 2: Build + verify.** `bunx turbo build` (server imports this package's dist), then `bun run verify-types && bun run lint:check && bun run test`.
- [ ] **Step 3: Commit.** `git add packages/backend-errors && git commit -m "feat(backend-errors): add INVALID_PRESET for the restart preset swap"`

---

## Task 2: Server — swap preset on restart

**Files:**
- Modify: `apps/server/api/src/api/subshells/restart-subshell.route.ts` (body schema, `400` response, doc)
- Modify: `apps/server/api/src/services/subshells.service.ts` (`restartSubshell`, L734-761: optional `swapPresetTo` param + validation)
- Modify: `apps/server/api/src/services/subshell-manager.service.ts` (`restartSubshell`, L704-774: optional `swapPresetTo`, the write + audit inside `run` after the kill, before `parkForRestart`)
- Test: Create `apps/server/api/src/api/subshells/__tests__/restart-preset-swap.route.test.ts`

**Interfaces:**
- Consumes: `BackendErrorCodes.INVALID_PRESET` (Task 1), `#gate(viewerId, id, "edit", actor)`, `this.repos.presets.findById` (the service's repos container — check it exposes `presets` like `nodes`/`subshells` do; it is the same container the presets routes use via `ctx.services`/`repos`).
- Produces: `POST /:id/restart` accepts `undefined | {} | { presetId: string | null }` bodies; `SubshellsService.restartSubshell(viewerId, id, actor, swapPresetTo?: string | null)`; `SubshellManager.restartSubshell(userId, sourceId, swapPresetTo?: string | null)`; audit event `subshell.preset_switch` with metadata `{ name, presetId }`.

TDD: write the failing route tests first, then implement.

- [ ] **Step 1: Failing tests.** Model setup on the closest existing restart tests — `grep -n "restart" apps/server/api/src/api/subshells/__tests__/subshells-maintenance.route.test.ts apps/server/api/src/services/__tests__/subshell-manager.service.test.ts` and copy how they get a RUNNING local subshell that survives a restart against the test fakes (the manager suites stub the launcher; the route suites use `helpers/auth-tables.ts`). Cover:
  1. no-body POST restarts and leaves `presetId` unchanged (also pins `{}` body → same);
  2. body `{ presetId: <caller's own preset, same harness> }` → row's `presetId` updated, restart succeeds, audit rows `subshell.preset_switch` (metadata `{name, presetId}`) + `subshell.restart` both written;
  3. body `{ presetId: null }` on a preset-launched row → column cleared, restart succeeds;
  4. 400 `INVALID_PRESET` for: unknown id; another user's preset; own preset of a different harness — each with `presetId` byte-identical afterwards and NO restart attempted;
  5. `view` grantee POSTing the same body → same refusal the no-body restart gives (403), preset untouched;
  6. swap to the SAME preset id → succeeds, `subshell.restart` row written, `subshell.preset_switch` row NOT written (the manager skips the write when unchanged — spec §3's "unchanged is a restart");
  7. bearer (subshell/system key) caller with no body still restarts via `requirePerm` exactly as before (pin the MCP tool's path);
  8. a 409 refusal leaves `presetId` byte-identical: node in maintenance (copy the setup from `subshells-maintenance.route.test.ts`), and — if the remote fakes in `subshells-remote.integration.test.ts` are reachable from a route test — an offline node. The maintenance case is required, the offline case is "if the fixture is cheap": as shipped (final review 2026-09-24), the service's offline pre-gate refuses a swap-carrying restart before the manager whenever the row's agent node has no live connection — the manager's kill only orders an ALIVE row's protection, so a dead row must not be able to swap past an unreachable node either; pin the maintenance ordering, which runs before the manager entirely.

  Run: `cd apps/server/api && bun test src/api/subshells/__tests__/restart-preset-swap.route.test.ts` — expect failures for every swap case.

- [ ] **Step 2: Route.** In `restart-subshell.route.ts` add a named body schema (code-style rule: named constants, described properties):

```ts
const RestartBodySchema = t.Object(
  {
    presetId: t.Optional(
      t.Nullable(
        t.String({
          description:
            "Swap the row's preset to this id (or null for presetless) before reviving: it must be a preset owned by the caller and share the subshell's harness. Absent = a plain restart with the preset it has.",
        }),
      ),
    ),
  },
  { description: "Optional preset swap applied inside this restart; a refusal writes nothing." },
);
```

Handler: destructure `body`, pass `ctx.services.subshells.restartSubshell(user.id, params.id, actor, body?.presetId)` (`undefined` = no swap; the Elysia-typed `string | null | undefined` maps to the service's optional param). Add `400: "ApiErrorResponse"` to `response`, and extend the route's doc-comment + `detail.description` to say the body exists. Import `t` from `elysia`.

- [ ] **Step 3: Service validation.** In `subshells.service.ts` `restartSubshell`, widen the signature with `swapPresetTo?: string | null` (document: `null` = swap to presetless, `undefined` = no swap; `@throws` gains "ApiError 400 INVALID_PRESET when the swap preset is unknown, not the caller's, or from another harness"). After `#gate` + the maintenance check (L746-753), before `this.#manager.restartSubshell`:

```ts
    // The swap is validated HERE — after the gate and every 409 refusal,
    // before the manager kills anything — so a refused restart never changes
    // the preset (spec 2026-09-23 §2). The preset must be the CALLER's (the
    // same per-user rule create enforces): a pane-token actor resolves through
    // the guard as its row's owner, so its swap lands on the owner's presets;
    // the system service user owns nothing and holds no grants, so the edit
    // gate above refuses it before this validation. And one of this row's
    // harness: a harness switch on a live row would silently
    // resume another agent's transcript in a different CLI.
    if (swapPresetTo !== undefined && swapPresetTo !== null) {
      const preset = await this.repos.presets.findById(swapPresetTo);
      if (!preset || preset.userId !== viewerId || preset.harnessId !== row.harnessId) {
        throwApiError({
          code: BackendErrorCodes.INVALID_PRESET,
          message: "The preset must exist, belong to you, and match the subshell's harness",
          doNotLog: true,
        });
      }
    }
```

Pass `swapPresetTo` through to `this.#manager.restartSubshell(row.userId, id, swapPresetTo)`. (If the service's repos container has no `presets`, use the same handle the create path uses for its owner-check at `subshell-manager.service.ts:328` — reuse that query rather than inventing one.)

- [ ] **Step 4: Manager write + audit.** In `subshell-manager.service.ts` `restartSubshell`, add `swapPresetTo?: string | null` to the signature (JSDoc: applied at the swap point, after the kill — see `#reviveRow`'s re-read). Inside the `run` IIFE, immediately AFTER the kill block (L712-719) and BEFORE `parkForRestart`:

```ts
      // The swap point (spec 2026-09-23): written only once the kill proved
      // the node reachable, and read fresh by #reviveRow's row re-read below.
      // A refusal that threw earlier leaves the column untouched; an
      // unchanged target is not a swap (no write, no audit row).
      if (swapPresetTo !== undefined && swapPresetTo !== source.presetId) {
        await this.#subshells.update(source.id, { presetId: swapPresetTo });
        await this.#audit({
          actorUserId: userId,
          action: "subshell.preset_switch",
          targetType: "subshell",
          targetId: source.id,
          metadataJson: JSON.stringify({ name: source.name, presetId: swapPresetTo }),
        });
      }
```

The `parked` re-read (L739) then carries the new value into `#reviveRow` untouched; `publishLive` (L769) announces both changes. No other pipeline change.

- [ ] **Step 5: Green + regression.** `cd apps/server/api && bun test src` (full package: the restart lease, maintenance and remote tests must not flake), `bun run verify-types`, `bun run lint:check`.
- [ ] **Step 6: Commit.** `git add apps/server/api && git commit -m "feat(server): swap a preset inside the restart route"`

---

## Task 3: Web — dialog + menu item

**Files:**
- Create: `apps/server/web/src/components/switch-preset-dialog.tsx`
- Modify: `apps/server/web/src/components/subshell-actions-menu.tsx` (state, item, dialog mount)
- Test: Create `apps/server/web/src/components/__tests__/switch-preset-dialog.test.tsx`; extend `apps/server/web/src/components/__tests__/subshell-actions-menu.test.tsx`

**Interfaces:**
- Consumes: `POST /api/subshells/:id/restart` with body (Task 2), `usePresets()` → `PresetRow[]` (`{ id, name, harnessId }`), `SubshellView` (`{ id, name, harnessId, presetId, access }`), `Select` grammar from `components/ui/select.tsx`, `SUBSHELLS_QUERY_KEY`/`SUBSHELL_QUERY_KEY`.
- Produces: `SwitchPresetDialog({ subshell, open, onOpenChange })`.

- [ ] **Step 1: Failing dialog tests** (model fetch stubbing + QueryClientProvider wrapper on `clone-subshell-dialog.test.tsx` and the helpers dir). Assert: initial selection shows the current preset name (and "None" for a presetless row); only same-harness presets are offered; choosing None posts `{ presetId: null }`; choosing a preset posts `{ presetId: "<id>" }`; confirming WITHOUT changing the selection still posts the current value (spec §3: unchanged is a restart, no client special case); the confirm button reads "Switch and restart"; a stubbed 400 keeps the dialog open and renders the error inline; the confirm is disabled while pending.
- [ ] **Step 2: Failing menu test**: with `canEdit` the items include "Switch preset…" beside Restart; a `view` viewer gets no menu at all (existing path, unchanged).
- [ ] **Step 3: Implement the dialog.** Composition copied from `CloneSubshellDialog` (`Dialog > DialogContent onClick stopPropagation > Header/Title/Description > body > Footer` with Cancel + primary; inline `text-destructive` error; mounted-while-open by the menu). Shape:

```tsx
export function SwitchPresetDialog({
  subshell,
  open,
  onOpenChange,
}: {
  subshell: SubshellView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { data: presets } = usePresets();
  const options = (presets ?? []).filter((p) => p.harnessId === subshell.harnessId);
  // Chosen wins; until then the row's preset, falling back to "none" once the
  // list has ANSWERED and cannot resolve it (a deleted preset, or one a
  // grantee swapped in — spec §3). In-flight is not "missing": the raw id
  // stays selected until the list proves otherwise.
  const [chosen, setChosen] = useState<string | null>(null);
  const selection =
    chosen ??
    (subshell.presetId === null
      ? "none"
      : presets === undefined
        ? subshell.presetId
        : options.some((p) => p.id === subshell.presetId)
          ? subshell.presetId
          : "none");
  const swap = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>(`/api/subshells/${subshell.id}/restart`, {
        method: "POST",
        body: JSON.stringify({ presetId: selection === "none" ? null : selection }),
      }),
    onSuccess: () => {
      // Same refresh the plain restart does — revival keeps the id.
      void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SUBSHELL_QUERY_KEY });
      onOpenChange(false);
    },
  });
```

The JSX below the mutation is the clone dialog's frame verbatim in shape. `DialogTitle` "Switch preset"; `DialogDescription` one sentence, no em dash: "The session restarts with the new preset's settings." The `Select` Root gets `items={[{ value: "none", label: "None" }, ...options.map((p) => ({ value: p.id, label: p.name }))]}` (Base UI prints the raw value without this map), "None" first as `SelectItem`, then the options, `value={selection}`, `onValueChange={(v) => v !== null && setChosen(v)}`; the select is `disabled` while `presets === undefined`. `DialogFooter`: outline Cancel (disabled while pending, closes) + primary Button `disabled={swap.isPending || presets === undefined}`, label `swap.isPending ? "Switching…" : "Switch and restart"`. Error line above the footer: `{swap.error && <p className="text-destructive text-sm">{(swap.error as Error).message || "Failed to switch preset"}</p>}` (`ApiError extends Error` and carries the server's structured message — verified `packages/node-admin/src/lib/api.ts:12`). Import grammar (`Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` from `@/components/ui/select`; `Dialog*` from `@/components/ui/dialog`; `Button` from `@internal/node-admin`) exactly as `new-subshell-form.tsx` and `clone-subshell-dialog.tsx` do; `apiFetch` from `@internal/node-admin`.
- [ ] **Step 4: Wire the menu item.** In `subshell-actions-menu.tsx`: `const [switchPresetOpen, setSwitchPresetOpen] = useState(false);`; import `ArrowLeftRight` and the dialog; insert directly AFTER the Restart / "Start again" spread (it is the same `canEdit` gate — write it as its own spread `...(canEdit ? [{ icon: ArrowLeftRight, label: "Switch preset…", sidebar: true, onSelect: () => setSwitchPresetOpen(true) }] : [])` with a comment saying a running pane is revived from the new preset, a dead one is started with it, and it replaces nothing: "Edit preset …" edits the definition, this changes which one the row uses); mount `{switchPresetOpen && <SwitchPresetDialog subshell={subshell} open onOpenChange={setSwitchPresetOpen} />}` beside the clone mount. Update the stale comment above the "Edit preset" item ("A subshell's preset is fixed at creation…") to name the swap as the live-pane path.
- [ ] **Step 5: Green + design lint.** `cd apps/server/web && bun test src/components/__tests__/switch-preset-dialog.test.tsx src/components/__tests__/subshell-actions-menu.test.tsx`, then root `bun run verify-types && bun run lint:check && bun run lint:design && bun run test`.
- [ ] **Step 6: Commit.** `git add apps/server/web && git commit -m "feat(server-web): Switch preset action with a restart-confirm dialog"`

---

## Task 4: Docs, changeset, final sweep

**Files:**
- Modify: `docs/security.md` (§10 audit-event list, Subshells line: add `preset_switch`)
- Modify: `.claude/rules/security-context.md` (same line: `subshell.create|terminate|restart|delete` → `subshell.create|terminate|restart|preset_switch|delete`)
- Modify: `apps/server/web/AGENTS.md` and/or `apps/server/api/AGENTS.md` ONLY if they assert the old fixed-at-creation rule (`grep -rn "fixed at creation" apps/ docs/ --include="*.md"`; the code comment was handled in Task 3)
- Create: `.changeset/<slug>.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: The two audit lists.** Add `subshell.preset_switch` to the §10 enumeration in `docs/security.md` and in the `.claude/rules/security-context.md` "Subshells:" line, matching each file's existing spelling. Note the semantics in `docs/security.md` beside the list entry style it uses: raised only when the swap changes the row, always beside a `subshell.restart`.
- [ ] **Step 2: AGENTS sweep.** Run the grep above; if either app's AGENTS.md states a subshell's preset cannot change after creation, update that sentence to name the swap (one sentence, matching the file's voice).
- [ ] **Step 3: Changeset.** `bunx changeset` (or hand-write): `"@internal/server": minor`, summary: swap a running subshell's preset from its action menu; the restart route takes an optional `presetId`. The `@internal/backend-errors` enum addition rides this changeset (it ships embedded in the server binary; the ignored-package rule in root AGENTS.md).
- [ ] **Step 4: Full verification.** From the worktree root: `bunx turbo build && bun run verify-types && bun run lint:check && bun run lint:design && bun run test` and `bun run lint:packages`. All green.
- [ ] **Step 5: Commit.** `git commit -am "docs: audit list + changeset for the preset swap"`

---

## Not in this plan (spec §7)

Harness changes; MCP `restart_subshell` body (stays `{ id }` — it sends no `presetId`, which is why the no-body path must keep passing Task 2 Step 1.1); swap-without-restart; a generic `PATCH /:id/preset`.
