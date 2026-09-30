# Close keeps the row; one New button on Prompts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Close" softens to terminate (row + history survive, row reaches the copy picker's "Recently terminated"); a new owner-only "Delete" on closed rows does what Close did; the `/prompts` header's two create buttons become one "New" dropdown.

**Architecture:** Pure client-side change. The server's `POST /api/subshells/:id/terminate` and `DELETE /api/subshells/:id` already exist and are unchanged; the gate is the server's (`terminate` = `edit`, delete = owner). Web SPA: confirmations lib → mutations hook → menu/terminal/dock/table surfaces → prompts route. Mobile app mirrors the verb map. No schema, no endpoint, no package change.

**Spec:** `docs/superpowers/specs/2026-09-29-close-keeps-the-row-design.md`

**Tech Stack:** React 19, TanStack Router/Query/Form, Base UI dropdown/dialog primitives, bun:test + @testing-library/react, Expo/React Native (mobile).

## Global Constraints

- UI copy carries **no em dashes** (`bun run lint:prose` fails on U+2014); confirm wording rule: TITLE is the question with the name in it, DESCRIPTION is one sentence.
- The three confirm strings, exact, everywhere:
  - Close: title `Close subshell "${name}"?` / "The process stops. The subshell and its history stay here until you delete them." / confirmLabel `Close` / NOT danger.
  - Delete: title `Delete subshell "${name}"?` / "This removes the subshell and its history permanently. It cannot be recovered." / confirmLabel `Delete` / danger.
  - Bulk Close: title `Close ${n} subshells?` (singular "1 subshell") / "Their processes stop. They stay listed until you delete them." / confirmLabel `Close` / NOT danger.
- No dynamic `await import()` anywhere (`.claude/rules/code-style.md`).
- Tests: run focused files while iterating; check the FILE COUNT (bun silently skips a nonexistent path).
- Verbs by row state (the whole contract): running row → Close (soft, `canEdit`); `status === "terminated"` row → Start again (`canEdit`) + Delete (owner-only). A crashed-but-tracked row (`status "running"`, `alive false`) still counts as running for the Close gate.
- Run each package's tests from its directory (`apps/server/web`, `apps/client/mobile`).

---

### Task 1: The confirmation lib gains Delete and the soft Close wording

**Files:**
- Modify: `apps/server/web/src/lib/subshell-confirmations.ts`
- Create: `apps/server/web/src/lib/__tests__/subshell-confirmations.test.tsx`

**Interfaces:**
- Produces: `confirmCloseSubshell(name: string): Promise<boolean>` (soft copy), `confirmDeleteSubshell(name: string): Promise<boolean>` (new), `confirmCloseSubshells(n: number): Promise<boolean>` (soft copy). All render through the app-wide `ConfirmProvider` (`@/components/ui/confirm-dialog`), which shows `Cancel` + the `confirmLabel` button.
- Consumes: `confirmAction` from `@internal/node-admin` (unchanged).

- [ ] **Step 1: Write the failing tests**

Create `apps/server/web/src/lib/__tests__/subshell-confirmations.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { confirmCloseSubshell, confirmCloseSubshells, confirmDeleteSubshell } from "@/lib/subshell-confirmations";

/** Renders the app's real confirm host around a button that runs one prompt
 *  and shows the outcome as its own name ("idle" → "yes"/"no"). */
function Ask({ ask }: { ask: () => Promise<boolean> }) {
  const [result, setResult] = useState("idle");
  return (
    <ConfirmProvider>
      <button type="button" onClick={() => void ask().then((ok) => setResult(ok ? "yes" : "no"))}>{result}</button>
    </ConfirmProvider>
  );
}

describe("subshell confirmations (spec 2026-09-29 close-keeps-the-row)", () => {
  afterEach(cleanup);

  it("Close asks the soft question and its Cancel answers false", async () => {
    render(<Ask ask={() => confirmCloseSubshell("Demo")} />);
    fireEvent.click(screen.getByRole("button", { name: "idle" }));
    expect(await screen.findByText('Close subshell "Demo"?')).toBeDefined();
    expect(
      screen.getByText("The process stops. The subshell and its history stay here until you delete them."),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "no" })).toBeDefined());
  });

  it("Close confirms true through its own label", async () => {
    render(<Ask ask={() => confirmCloseSubshell("Demo")} />);
    fireEvent.click(screen.getByRole("button", { name: "idle" }));
    await screen.findByText('Close subshell "Demo"?');
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "yes" })).toBeDefined());
  });

  it("Delete is the one that promises permanence", async () => {
    render(<Ask ask={() => confirmDeleteSubshell("Demo")} />);
    fireEvent.click(screen.getByRole("button", { name: "idle" }));
    expect(await screen.findByText('Delete subshell "Demo"?')).toBeDefined();
    expect(
      screen.getByText("This removes the subshell and its history permanently. It cannot be recovered."),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "yes" })).toBeDefined());
  });

  it("bulk close counts, asks once, and stays plural-safe", async () => {
    render(<Ask ask={() => confirmCloseSubshells(2)} />);
    fireEvent.click(screen.getByRole("button", { name: "idle" }));
    expect(await screen.findByText("Close 2 subshells?")).toBeDefined();
    expect(screen.getByText("Their processes stop. They stay listed until you delete them.")).toBeDefined();
    cleanup();
    render(<Ask ask={() => confirmCloseSubshells(1)} />);
    fireEvent.click(screen.getByRole("button", { name: "idle" }));
    expect(await screen.findByText("Close 1 subshell?")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run them, verify they fail on the wording**

Run: `cd apps/server/web && bun test src/lib/__tests__/subshell-confirmations.test.tsx`
Expected: FAIL (old Close copy is the permanent sentence; `confirmDeleteSubshell` does not exist).

- [ ] **Step 3: Rewrite the lib**

In `apps/server/web/src/lib/subshell-confirmations.ts`, replace the module header comment's spec-2026-09-03 paragraph (the one saying Close is DELETE's human name) with:

```ts
/**
 * Confirmation prompts for the subshell lifecycle, asked by
 * `useSubshellMutations` (the menu, the cards, the rows, the terminal's
 * dead panel), the workspace dock, and the manager table's bulk action, so
 * the wording — and the fact that it asks at all — stays identical wherever
 * it is triggered from.
 *
 * Since spec 2026-09-29 (close-keeps-the-row) the two verbs are two prompts:
 * Close stops the process and KEEPS the row and its history (a soft act, no
 * longer styled danger), and Delete — offered only on closed rows — is the
 * permanent one that removes row and log. Bulk follows Close's soft rule.
 *
 * Wording rule: the TITLE is the question with the subshell's name in it;
 * the DESCRIPTION is the one-sentence consequence. Never a whole sentence
 * as the heading — the dialog renders the title large.
 *
 * They render through the app-wide styled dialog (`lib/confirm`), so they
 * are async: `if (await confirmCloseSubshell(name)) …`.
 */
```

Replace `confirmCloseSubshell` (keep its JSDoc style; the function bodies are the whole change):

```ts
/**
 * Confirmation prompt before closing a subshell — the SOFT act (spec
 * 2026-09-29): it stops the process and keeps the row, restartable, until a
 * Delete. Recoverable, so it is not a danger prompt.
 * @param name - The subshell's display name (or id, if the name isn't loaded yet)
 * @returns True if the user confirmed
 */
export function confirmCloseSubshell(name: string): Promise<boolean> {
  return confirmAction({
    title: `Close subshell "${name}"?`,
    description: "The process stops. The subshell and its history stay here until you delete them.",
    confirmLabel: "Close",
  });
}

/**
 * Confirmation prompt before DELETING a closed subshell — the permanent act:
 * removes the row and its log. This is the sentence Close used to carry.
 * @param name - The subshell's display name
 * @returns True if the user confirmed
 */
export function confirmDeleteSubshell(name: string): Promise<boolean> {
  return confirmAction({
    title: `Delete subshell "${name}"?`,
    description: "This removes the subshell and its history permanently. It cannot be recovered.",
    confirmLabel: "Delete",
    danger: true,
  });
}
```

And the bulk prompt:

```ts
/** Confirmation prompt before closing `n` subshells (bulk {@link confirmCloseSubshell}). */
export function confirmCloseSubshells(n: number): Promise<boolean> {
  return confirmAction({
    title: `Close ${count(n)}?`,
    description: "Their processes stop. They stay listed until you delete them.",
    confirmLabel: "Close",
  });
}
```

- [ ] **Step 4: Run the tests, verify pass**

Run: `cd apps/server/web && bun test src/lib/__tests__/subshell-confirmations.test.tsx`
Expected: PASS, 4 files/`4 pass 0 fail` (the file count line is the harness check).

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/lib/subshell-confirmations.ts apps/server/web/src/lib/__tests__/subshell-confirmations.test.tsx
git commit -m "Confirmations: Close asks the soft question; Delete gets the permanent one"
```

---

### Task 2: The mutations hook gains the soft close

**Files:**
- Modify: `apps/server/web/src/hooks/use-subshell-mutations.ts`

**Interfaces:**
- Produces: `SubshellMutations` now `{ restart: () => void; close: () => Promise<void>; remove: () => Promise<void>; toggleNotify: () => Promise<void>; busy: boolean; restarting: boolean; deleting: boolean }`. `close` POSTs `/api/subshells/${id}/terminate` behind `confirmCloseSubshell`; `remove` stays the DELETE behind the NEW `confirmDeleteSubshell`.
- Consumes: Task 1's `confirmDeleteSubshell`.

- [ ] **Step 1: Add the close mutation and re-gate remove**

In `apps/server/web/src/hooks/use-subshell-mutations.ts`:

Import change: the `@/lib/subshell-confirmations` import line becomes exactly:

```ts
import { confirmCloseSubshell, confirmDeleteSubshell } from "@/lib/subshell-confirmations";
```

Add after the `remove` mutation (same file, same indentation):

```ts
  const close = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>(`/api/subshells/${id}/terminate`, { method: "POST" }),
    // A soft close keeps the row: the list, the detail, and the workspace
    // panes all re-read it (pane rows copy status/alive, same fact restart
    // and delete rely on).
    onSuccess: refreshWithPanes,
  });
```

Return block becomes:

```ts
  return {
    restart: runNow(restart),
    close: () => askThen(confirmCloseSubshell, close),
    remove: () => askThen(confirmDeleteSubshell, remove),
    toggleNotify: () => toggleNotify.mutateAsync().then(() => undefined),
    busy: restart.isPending || close.isPending || remove.isPending,
    restarting: restart.isPending,
    deleting: remove.isPending,
  };
```

Update the `SubshellMutations` interface doc entries:

```ts
  /** Asks, then closes the subshell SOFTLY: stops the process, keeps the row and its history (spec 2026-09-29) */
  close: () => Promise<void>;
  /** Asks, then removes the row and its log. Offered only on closed rows */
  remove: () => Promise<void>;
```

Replace the stale header paragraph (lines ~29-35, "Terminate is deliberately absent from the human UI (spec 2026-09-03): Close subsumes it…") with:

```
 * Terminate is the human Close again (spec 2026-09-29, close-keeps-the-row):
 * Close POSTs `/terminate` and keeps the row, so a closed subshell stays
 * restartable and keeps offering its settings to the launch picker. Delete is
 * the permanent one, asked with its own prompt and offered only on closed
 * rows; the server keeps the gates (terminate at `edit`, delete owner-only).
 * Renaming is likewise the ONLY title-pin gesture — no separate lock mutation.
```

And the inline comment above the return (`// Closing is destructive and always asks…`) to:

```ts
  // Both asks stand: Close stops live work (recoverable, one soft confirm),
  // Delete is permanent. Restart does not ask: it revives the same subshell
  // and resumes the conversation.
```

- [ ] **Step 2: Type-check the package**

Run: `bunx turbo verify-types --filter=@internal/server-web` (adjust the filter name to the web package's actual name shown in `apps/server/web/package.json` if different)
Expected: PASS (no consumer uses the new member yet).

- [ ] **Step 3: Commit**

```bash
git add apps/server/web/src/hooks/use-subshell-mutations.ts
git commit -m "Mutations hook: Close POSTs terminate behind the soft confirm; Delete asks the permanent one"
```

---

### Task 3: The actions menu splits Close from Delete

**Files:**
- Modify: `apps/server/web/src/components/subshell-actions-menu.tsx`
- Test: `apps/server/web/src/components/__tests__/subshell-actions-menu.test.tsx`

**Interfaces:**
- Consumes: Task 2's `close` member; Task 1's copy.
- Produces: menu verb map — running row (`canEdit && status === "running"`): "Close" (icon `X`, `sidebar: true`, NOT destructive, `close()`); closed row (`isOwner && status === "terminated"`): "Delete" (icon `Trash2`, `destructive: true`, `sidebar: true`, `remove()`); existing "Start again" item untouched.

- [ ] **Step 1: Update the failing pins and add the new ones**

In `apps/server/web/src/components/__tests__/subshell-actions-menu.test.tsx`:

(a) Wrap the menu in the real confirm host so click-through tests can answer the prompt. Add the import:

```tsx
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
```

and in `renderMenu`, wrap the component (inside the route `component`):

```tsx
    component: () => (
      <ConfirmProvider>
        <SubshellActionsMenu subshell={subshell} diagnostics={diagnostics} copyMode={copyMode}>
          {children}
        </SubshellActionsMenu>
      </ConfirmProvider>
    ),
```

(b) The view-grantee gate list: add `"Delete"` to the array of names asserted absent (the list around line 164 that already holds "Close").

(c) "an edit grantee can manage the subshell but not the bell, sharing, or closing" (around line 196): edit grantees DO get soft Close now. Change the last two asserts to:

```tsx
      // Close is soft and an `edit` act (the server gates terminate at edit,
      // spec 2026-09-29); the permanent Delete stays owner-only.
      expect(screen.getByRole("menuitem", { name: "Close" })).toBeDefined();
      expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
```

(d) The right-click sidebar test (~line 494) keeps 7 items and "Close" for a RUNNING owner row (unchanged: Close is still sidebar-flagged) — but update its stale comment sentence "Terminate is gone (Close subsumes it; …)" to "Terminate is gone as a name (Close IS the soft terminate since spec 2026-09-29; …)".

(e) Append the new behavior block:

```tsx
describe("SubshellActionsMenu — soft Close, owner Delete (spec 2026-09-29)", () => {
  afterEach(cleanup);

  it("Close on a running row asks the soft question, then POSTs terminate", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderMenu(makeSubshell({ id: "abc" }));
      await openMenu("subshell");
      fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
      expect(
        await screen.findByText("The process stops. The subshell and its history stay here until you delete them."),
      ).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() =>
        expect(calls).toContainEqual({ method: "POST", url: "/api/subshells/abc/terminate", body: undefined }),
      );
    } finally {
      restore();
    }
  });

  it("a closed row lists Delete, never Close; confirming it DELETEs the row", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderMenu(makeSubshell({ id: "abc", alive: false, status: "terminated" }));
      await openMenu("subshell");
      expect(screen.queryByRole("menuitem", { name: "Close" })).toBeNull();
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      expect(
        await screen.findByText("This removes the subshell and its history permanently. It cannot be recovered."),
      ).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() =>
        expect(calls).toContainEqual({ method: "DELETE", url: "/api/subshells/abc", body: undefined }),
      );
    } finally {
      restore();
    }
  });

  it("an edit grantee on a closed row gets Start again only — no Close, no Delete", async () => {
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSubshell({ access: "edit", alive: false, status: "terminated" }));
      await openMenu("subshell");
      expect(screen.getByRole("menuitem", { name: "Start again" })).toBeDefined();
      expect(screen.queryByRole("menuitem", { name: "Close" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    } finally {
      restore();
    }
  });
});
```

- [ ] **Step 2: Run them, verify the new block fails**

Run: `cd apps/server/web && bun test src/components/__tests__/subshell-actions-menu.test.tsx`
Expected: FAIL on "Close … POSTs terminate" (current Close DELETEs) and on "Delete" absence on running rows.

- [ ] **Step 3: Rewrite the menu items**

In `apps/server/web/src/components/subshell-actions-menu.tsx`:

Imports: add `Trash2` to the lucide list (keep `X`, it is still Close's icon); destructure the new member:

```ts
  const { restart, close, remove, toggleNotify, busy } = useSubshellMutations(subshell.id, subshell, {
    onDeleted,
  });
```

Update the "Lifecycle shrank…" comment (lines ~94-95) to:

```ts
  // Two lifecycle verbs (spec 2026-09-29, close-keeps-the-row): Close is the
  // soft terminate an `edit` act, and the permanent Delete belongs to the
  // owner alone and exists only once a row is closed.
```

Replace the Close line inside the final `isOwner` block so it reads:

```ts
    ...(isOwner
      ? [
          { icon: Share2, label: "Share…", sidebar: true, onSelect: () => setShareOpen(true) },
          // Delete is the permanent act (removes row + log) and exists only
          // once the row is closed: first Close (soft), then Delete. Owner-
          // only, exactly the share-rule posture (delete is never conferred).
          ...(subshell.status === "terminated"
            ? [{ icon: Trash2, label: "Delete", destructive: true, sidebar: true, onSelect: () => void remove() }]
            : []),
        ]
      : []),
```

and add the soft Close item just BEFORE that `isOwner` block (so `edit` grantees get it too):

```ts
    // Close is soft (spec 2026-09-29): it POSTs terminate, keeping the row
    // restartable and its settings copyable. Offered on every not-yet-closed
    // row — including a crashed-but-tracked one, where it is the act that
    // declares the row done. Not destructive-red: the confirm says what
    // stays.
    ...(canEdit && subshell.status === "running"
      ? [{ icon: X, label: "Close", sidebar: true, onSelect: () => void close() }]
      : []),
```

Fix the two now-false comments it strands: the "Revive is the sidebar's remaining lifecycle gesture" block's parenthetical "no stop action — Close removes it outright, which terminates first" → "a live subshell's stop action is Close (soft, below); a closed one revives here".

- [ ] **Step 4: Run the suite file, verify pass**

Run: `cd apps/server/web && bun test src/components/__tests__/subshell-actions-menu.test.tsx`
Expected: PASS (all tests including the updated pins).

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/components/subshell-actions-menu.tsx apps/server/web/src/components/__tests__/subshell-actions-menu.test.tsx
git commit -m "Actions menu: Close softens to terminate (edit gate); Delete arrives on closed rows (owner only)"
```

---

### Task 4: The terminal's dead panel deletes

**Files:**
- Modify: `apps/server/web/src/lib/dead-panel-actions.ts`
- Test: `apps/server/web/src/lib/__tests__/dead-panel-actions.test.ts`
- Modify: `apps/server/web/src/components/subshell-terminal.tsx`
- Modify: `apps/server/web/src/routes/subshells_.$id.tsx` (comment only)

**Interfaces:**
- Produces: `deadPanelActions(access: SubshellAccess | undefined): { restart: boolean; delete: boolean }` (key `close` renamed to `delete`; same gate: restart at `access !== "view"`, delete at `access === "owner"`).
- Consumes: Task 2's `remove` (the route already wires `onDelete={() => void remove()}` — unchanged, it just now confirms Delete).

- [ ] **Step 1: Update the failing test**

In `apps/server/web/src/lib/__tests__/dead-panel-actions.test.ts`, rename the key in all four expectations and the describe prose:

```ts
describe("deadPanelActions", () => {
  it("lets the owner both revive and delete", () => {
    expect(deadPanelActions("owner")).toEqual({ restart: true, delete: true });
  });

  it("gives an edit grantee revive but never Delete (delete stays owner-only)", () => {
    expect(deadPanelActions("edit")).toEqual({ restart: true, delete: false });
  });

  it("gives a viewer neither button", () => {
    expect(deadPanelActions("view")).toEqual({ restart: false, delete: false });
  });

  it("keeps both buttons when no record is loaded (mid-view delete; the backend still gates)", () => {
    expect(deadPanelActions(undefined)).toEqual({ restart: true, delete: true });
  });
});
```

Run `cd apps/server/web && bun test src/lib/__tests__/dead-panel-actions.test.ts`; expect FAIL on key name.

- [ ] **Step 2: Rewrite the helper and the panel**

`dead-panel-actions.ts` body (and its JSDoc line "only the `owner` may Close (delete)" → "only the `owner` may Delete; since spec 2026-09-29 Close is the SOFT terminate and lives in the actions menu, not this panel"):

```ts
export function deadPanelActions(access: SubshellAccess | undefined): { restart: boolean; delete: boolean } {
  if (access === undefined) return { restart: true, delete: true };
  return { restart: access !== "view", delete: access === "owner" };
}
```

In `subshell-terminal.tsx`, the dead panel (around lines 1098-1107): the second button becomes Delete (`Trash2` icon — add it to the lucide import; keep `X` if the file uses it elsewhere, check first), gate `.close` → `.delete`, label `{deleting ? "Deleting…" : "Delete"}`; the block comment above it (`\`edit\` revives, only the \`owner\` may Close (delete)…`) rewords Close→Delete throughout. Also the `isSubshellDead` JSDoc (lines ~334-335) "with Restart/Close" → "with Restart/Delete".

- [ ] **Step 3: Run and commit**

Run: `cd apps/server/web && bun test src/lib/__tests__/dead-panel-actions.test.ts && bunx turbo verify-types --filter=@internal/server-web`
Expected: PASS.

```bash
git add apps/server/web/src/lib/dead-panel-actions.ts apps/server/web/src/lib/__tests__/dead-panel-actions.test.ts apps/server/web/src/components/subshell-terminal.tsx "apps/server/web/src/routes/subshells_.\$id.tsx"
git commit -m "Terminal dead panel: the second button is Delete now that closing keeps the row"
```

---

### Task 5: The dock's tile Close and the table's bulk Close go soft

**Files:**
- Modify: `apps/server/web/src/components/workspace-dock.tsx:316-332`
- Modify: `apps/server/web/src/components/subshell-manager-table.tsx:50-75`

**Interfaces:**
- Consumes: `confirmCloseSubshell` / `confirmCloseSubshells` (Task 1 copy, imported already).
- Produces: no new exports; both call sites POST `/terminate`.

- [ ] **Step 1: Reroute the dock handler**

In `handleCloseSubshell` (workspace-dock.tsx ~line 316), replace the DELETE body and its cascade comment:

```ts
      if (!(await confirmCloseSubshell(name))) return;
      try {
        // Soft Close (spec 2026-09-29): POST terminate keeps the row, so the
        // tile STAYS and renders its dead state (the log tail with Restart).
        // Removing the tile is the separate handleClosePane path; the hard
        // Delete lives on the closed row's menu.
        await apiFetch(`/api/subshells/${subshellId}/terminate`, { method: "POST" });
        void onRefetch();
      } catch (err) {
        setError(errMessage(err, "Failed to close subshell"));
      }
```

- [ ] **Step 2: Reroute the bulk action**

In `subshell-manager-table.tsx` `runBulk`, the endpoint/method lines become:

```ts
      // Loop the existing per-subshell endpoints for the selected rows.
      // Bulk Close is soft since spec 2026-09-29: the same terminate POST the
      // row menu sends; bulk Delete does not exist (row menus carry it).
      const endpoint =
        action === "close" ? (id: string) => `/api/subshells/${id}/terminate` : (id: string) => `/api/subshells/${id}/${action}`;
      const results = await Promise.allSettled(selectedIds.map((id) => apiFetch(endpoint(id), { method: "POST" })));
```

and update the ask-comment above `confirmCloseSubshells(n)` ("Bulk close is destructive and asks…") to "Bulk close stops live work and asks; bulk restart does not (it spawns subshells and resumes conversations — nothing is lost)."

- [ ] **Step 3: Type-check, then commit**

Run: `bunx turbo verify-types --filter=@internal/server-web` — PASS.

```bash
git add apps/server/web/src/components/workspace-dock.tsx apps/server/web/src/components/subshell-manager-table.tsx
git commit -m "Dock tile close and bulk close follow the new soft Close"
```

---

### Task 6: One "New" button on the Prompts page

**Files:**
- Modify: `apps/server/web/src/routes/prompts.tsx:460-477` (+ imports)
- Test: `apps/server/web/src/routes/__tests__/prompts-page.test.tsx`

**Interfaces:**
- Produces: header renders one `<Button>` named "New" opening a `DropdownMenu` with items "New prompt" / "New stack" gated exactly as the old buttons were (`activeView !== "stacked"` / `activeView !== "single"`), calling `setShowCreate(true)` / `setStackDialog({})`. Dialogs and edit flows untouched.
- Consumes: `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuTrigger` from `@/components/ui/dropdown-menu` (same primitives `actions-menu.tsx` wraps).

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/web/src/routes/__tests__/prompts-page.test.tsx` (same file, after the existing describes; reuse its `mockFetch`, `renderPage`, `settle`, `afterEach`):

```tsx
describe("/prompts create action (spec 2026-09-29: one New button)", () => {
  it("the header carries ONE New button offering both kinds on All", async () => {
    const { restore } = mockFetch();
    try {
      renderPage();
      await screen.findByText("Kickoff");
      expect(screen.queryByRole("button", { name: "New prompt" })).toBeNull();
      expect(screen.queryByRole("button", { name: "New stack" })).toBeNull();
      // Base UI triggers open on pointerdown, which happy-dom cannot
      // emulate; ArrowDown is the keyboard path (the actions-menu tests' idiom).
      fireEvent.keyDown(screen.getByRole("button", { name: "New" }), { key: "ArrowDown" });
      await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(2));
      expect(screen.getByRole("menuitem", { name: "New prompt" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "New stack" })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("Single's menu lists only the prompt, Stacked's only the stack", async () => {
    const { restore } = mockFetch();
    try {
      renderPage("/prompts?view=single");
      await screen.findByText("Kickoff");
      fireEvent.keyDown(screen.getByRole("button", { name: "New" }), { key: "ArrowDown" });
      await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(1));
      expect(screen.getByRole("menuitem", { name: "New prompt" })).toBeDefined();
      cleanup();
      renderPage("/prompts?view=stacked");
      await screen.findByText("Morning set");
      fireEvent.keyDown(screen.getByRole("button", { name: "New" }), { key: "ArrowDown" });
      await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(1));
      expect(screen.getByRole("menuitem", { name: "New stack" })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("the items open their dialogs unchanged", async () => {
    const { restore } = mockFetch();
    try {
      renderPage();
      await screen.findByText("Kickoff");
      fireEvent.keyDown(screen.getByRole("button", { name: "New" }), { key: "ArrowDown" });
      await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(2));
      fireEvent.click(screen.getByRole("menuitem", { name: "New prompt" }));
      expect(await screen.findByRole("heading", { name: "New prompt" })).toBeDefined();
      // No fighting the dialog's close affordance: unmount and re-render
      // fresh, then take the other item.
      cleanup();
      renderPage();
      await screen.findByText("Kickoff");
      fireEvent.keyDown(screen.getByRole("button", { name: "New" }), { key: "ArrowDown" });
      await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(2));
      fireEvent.click(screen.getByRole("menuitem", { name: "New stack" }));
      expect(await screen.findByRole("heading", { name: "New stack" })).toBeDefined();
    } finally {
      restore();
    }
  });
});
```

- [ ] **Step 2: Run, verify fail** (no button named "New"; two named buttons exist).

Run: `cd apps/server/web && bun test src/routes/__tests__/prompts-page.test.tsx`

- [ ] **Step 3: Implement**

In `prompts.tsx`, add the import (after the `Segmented` import line):

```ts
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
```

Replace the PageHeader `action={...}` block (lines ~460-477) with:

```tsx
        action={
          // One "New" (operator ruling 2026-09-29: the two-button pair read
          // as clutter). The dropdown carries the KIND choice; the per-view
          // rule survives inside it, and both create dialogs stay as they
          // were. Shared tab renders no create action, as before.
          activeTab === "own" ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button />}>
                <Plus /> New
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {activeView !== "stacked" && (
                  <DropdownMenuItem onSelect={() => setShowCreate(true)}>
                    <MessageSquareText className="h-4 w-4" /> New prompt
                  </DropdownMenuItem>
                )}
                {activeView !== "single" && (
                  <DropdownMenuItem onSelect={() => setStackDialog({})}>
                    <Layers className="h-4 w-4" /> New stack
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
```

(`MessageSquareText`, `Layers`, `Plus` are already imported at line 3.)

- [ ] **Step 4: Run the file, verify pass**

Run: `cd apps/server/web && bun test src/routes/__tests__/prompts-page.test.tsx` — expect PASS. If Base UI's trigger renders the `<Button>` without the accessible name from its children (happy-dom quirk), the button query falls back to `getByRole("button", { name: /New/ })`; check the rendered markup before changing assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/routes/prompts.tsx apps/server/web/src/routes/__tests__/prompts-page.test.tsx
git commit -m "Prompts page: one New button; the kind menu launches the create dialogs"
```

---

### Task 7: Mobile mirrors the verbs

**Files:**
- Modify: `apps/client/mobile/src/lib/api.ts`
- Test: `apps/client/mobile/src/lib/__tests__/api.test.ts`
- Modify: `apps/client/mobile/src/components/subshell-detail.tsx:207-228`
- Modify: `apps/client/mobile/src/lib/subshell-access.ts` (doc only)

**Interfaces:**
- Produces: `SubshellClient.terminate(id): Promise<{ ok: true }>` POSTs `/api/subshells/:id/terminate`. Detail sheet: Close (`flags.canEdit && status === "running"`) → terminate + stay; Delete (`flags.isOwner && status === "terminated"`) → delete + go back.
- Consumes: nothing from web tasks.

- [ ] **Step 1: Write the failing API test**

In `apps/client/mobile/src/lib/__tests__/api.test.ts`, add beside the existing `deleteSubshell` tuple (match the file's tuple shape, `["name", call, METHOD, url]`):

```ts
    ["terminate", (c) => c.terminate("s1"), "POST", `${BASE}/api/subshells/s1/terminate`],
```

Run: `cd apps/client/mobile && bun test src/lib/__tests__/api.test.ts` — expect FAIL (`terminate` missing).

- [ ] **Step 2: Add the client method**

In `apps/client/mobile/src/lib/api.ts`, replace the `// No terminate(): …` comment (lines ~217-218) with:

```ts
  /**
   * Soft Close (spec 2026-09-29, close-keeps-the-row): stops the process and
   * KEEPS the row and history, restartable. The UI calls this "Close".
   * @param id - Subshell id
   */
  terminate(id: string): Promise<{ ok: true }> {
    return this.request(`/api/subshells/${encodeURIComponent(id)}/terminate`, { method: "POST" });
  }

  /** Removes the row and its log. Permanent — the UI calls this "Delete" and shows it only on closed rows. @param id - Subshell id */
```

(keep `deleteSubshell`'s signature and body).

- [ ] **Step 3: Swap the detail sheet's verbs**

In `subshell-detail.tsx`, replace the "No Terminate action" comment + owner-gated Close block with:

```tsx
          {/* Close is soft (spec 2026-09-29): it POSTs terminate and keeps the
              row, so the sheet stays open on the dead state. Delete is the
              permanent one, owner-only, and exists only once the row is
              closed. */}
          {flags.canEdit && subshell?.status === "running" && (
            <Action
              label="Close"
              onPress={() =>
                confirmAction(
                  "Close?",
                  "The process stops. The subshell and its history stay here until you delete them.",
                  "Close",
                  () => void run("Close", (cli) => cli.terminate(subshellId)),
                )
              }
            />
          )}
          {flags.isOwner && subshell?.status === "terminated" && (
            <Action
              label="Delete"
              color={colors.destructive}
              onPress={() =>
                confirmAction(
                  "Delete?",
                  "This removes the subshell and its history permanently. It cannot be recovered.",
                  "Delete",
                  () =>
                    void run("Delete", async (cli) => {
                      await cli.deleteSubshell(subshellId);
                      if (onBack) onBack();
                      else router.back();
                    }),
                  { destructive: true },
                )
              }
            />
          )}
```

In `subshell-access.ts`, update the doc lines: `- edit: … but not the owner-only bell or Delete` and `isOwner … the notification bell / Delete available (owner-only)`, and `canEdit`'s comment to `rename / restart / close (soft) available`.

- [ ] **Step 4: Run mobile checks and commit**

Run: `cd apps/client/mobile && bun test src/lib/__tests__/api.test.ts` — PASS.
Run: `bunx turbo verify-types --filter=@internal/mobile` — PASS.

```bash
git add apps/client/mobile/src/lib/api.ts apps/client/mobile/src/lib/__tests__/api.test.ts apps/client/mobile/src/components/subshell-detail.tsx apps/client/mobile/src/lib/subshell-access.ts
git commit -m "Mobile: Close softens to terminate; Delete arrives on closed rows"
```

---

### Task 8: Docs sweep and full verification

**Files:**
- Modify: `docs/security.md` (the §5 edit bullet, ~line 732-738)
- Modify: `.claude/rules/security-context.md` (the Sharing bullet, line ~55)

- [ ] **Step 1: Rewrite the two security-doc sentences about the missing button**

`docs/security.md` §5 — replace the parenthetical "(The 2026-09-03 close-vocabulary spec shed the terminate BUTTON from every human surface, Close = delete subsumes it, while `POST /:id/terminate` stayed live at `edit`, because …)" with:

```
  (The 2026-09-03 close-vocabulary spec had Close DELETE and no terminate
  button; spec 2026-09-29 close-keeps-the-row returned the human UI to the
  `POST /:id/terminate` path: Close is now the soft terminate an `edit` act,
  and the permanent removal is its own owner-only Delete verb, offered only
  on closed rows: spec
  2026-09-29-close-keeps-the-row-design.md.)
```

`.claude/rules/security-context.md` line ~55 — replace "( `POST /:id/terminate` stays live at `edit` at REST/MCP level though the button left the UI)" with "(since spec 2026-09-29 the human **Close** IS this act)" and after "delete, managing shares, the notification bell" the delete sentence now reads "delete (the human **Delete**, shown only on closed rows), managing shares, the notification bell".

- [ ] **Step 2: Sweep for stragglers**

Run: `grep -rn "Close subsumes\|removes it outright\|Close removes\|button left the UI\|dropped the action\|No Terminate action" docs .claude apps --include=*.ts --include=*.tsx --include=*.md | grep -v node_modules`
Fix every remaining hit's wording (each is a sentence describing the old lifecycle; say the new one). Expected: zero hits after.

- [ ] **Step 3: Task-boundary full verification**

```bash
bun run verify-types
bun run lint:check
bun run lint:prose
bun run test
```

Expected: all green. `lint:prose` guards the new copy against U+2014; `bun run test` covers web + mobile + server suites (no server code changed — if a server test pins the old Close wording anywhere, update the test, never the endpoint).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Close keeps the row: security docs and stale comments follow the new lifecycle"
```

---

## Out of this plan

- Deploying (rebuild `@internal/server-web` dist + restart the service per `docs/subshell-rollout.md` habits) — a live check should happen on the operator's real client, not a local render.
- Any server/DB change (there is none to make).
