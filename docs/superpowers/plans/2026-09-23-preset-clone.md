# Clone a preset from the action menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Clone preset" item to the `/presets` row action menu that opens the create dialog prefilled from the source preset with a collision-free suggested name.

**Architecture:** Entirely client-side in `apps/server/web` (the SPA). A pure name-suggester joins `lib/preset-form.ts`; `CreatePresetDialog` gains an `initialForm` prop (its third posture); `routes/presets.tsx` wires the menu item and mounts the dialog. No API, DB, or server changes — the browser already holds each row in the `usePresets()` cache, and the existing `POST /api/presets` + duplicate-name 409 handle the rest.

**Tech Stack:** React 19, TanStack Router/Query, Base UI, lucide-react; `bun test` + @testing-library/react (happy-dom) for unit/component tests; Playwright e2e in `e2e/`.

**Spec:** `docs/superpowers/specs/2026-09-23-preset-clone-design.md`

## Global Constraints

- UI copy: **no em dashes**; every added string is a plain label (`"Clone preset"`). No literal font sizes/weights/colors (`bun run lint:design` fails on them) — this plan adds none, only text.
- Tests: `bun test` from `apps/server/web` (`cd /home/theo/projects/subshell/apps/server/web && bun test <file>`). e2e runs from `e2e/` and boots its own backend on :3199 (`cd /home/theo/projects/subshell/e2e && bun run test:e2e tests/04-presets.spec.ts`); one-time `bunx playwright install chromium` if the browser is missing.
- Never test against the live instance (:3080).
- Commit scopes follow the repo: `feat(server-web): …` for SPA work (see `git log -- apps/server/web`).
- `harnessId` is immutable after create: the clone POSTs a create with the SAME harness and the dialog shows the agent locked (static text, not a select).
- The collision scope is the DB's UNIQUE index `(user_id, harness_id, name COLLATE NOCASE)` — compare names case-insensitively, within the same `harnessId` only.

---

### Task 1: `suggestCloneName` pure helper

**Files:**
- Modify: `apps/server/web/src/lib/preset-form.ts` (append at end of file)
- Test: `apps/server/web/src/lib/__tests__/preset-form.test.ts` (add a describe block; the file already has a `baseRow: PresetRow` fixture at the top to reuse)

**Interfaces:**
- Consumes: `PresetRow` from `@/types/preset` (fields used: `id`, `harnessId`, `name`).
- Produces: `suggestCloneName(rows: PresetRow[], source: PresetRow): string` exported from `@/lib/preset-form` — Task 3 calls it with the cached list and the clicked row.

- [ ] **Step 1: Write the failing tests**

Add `suggestCloneName` to the existing import block from `"../preset-form"` in `src/lib/__tests__/preset-form.test.ts`, and append this describe block at the end of the file:

```ts
describe("suggestCloneName", () => {
  const row = (over: Partial<PresetRow>): PresetRow => ({ ...baseRow, ...over });

  it("suggests (2) when nothing collides", () => {
    const src = row({ id: "a", name: "Work" });
    expect(suggestCloneName([src], src)).toBe("Work (2)");
  });

  it("skips taken suffixes and fills a gap", () => {
    const src = row({ id: "a", name: "Work" });
    const rows = [src, row({ id: "b", name: "Work (2)" }), row({ id: "c", name: "Work (4)" })];
    expect(suggestCloneName(rows, src)).toBe("Work (3)");
  });

  it("matches case-insensitively like the NOCASE index", () => {
    const src = row({ id: "a", name: "Work" });
    expect(suggestCloneName([src, row({ id: "b", name: "wOrK (2)" })], src)).toBe("Work (3)");
  });

  it("ignores a same-named row under a different harness", () => {
    const src = row({ id: "a", name: "Work" });
    const rows = [src, row({ id: "b", name: "Work (2)", harnessId: "pi" })];
    expect(suggestCloneName(rows, src)).toBe("Work (2)");
  });

  it("a source already named X (2) nests the suffix, deterministically", () => {
    const src = row({ id: "a", name: "Work (2)" });
    expect(suggestCloneName([src], src)).toBe("Work (2) (2)");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/theo/projects/subshell/apps/server/web && bun test src/lib/__tests__/preset-form.test.ts`
Expected: FAIL — the module has no export named `suggestCloneName` (import-time SyntaxError).

- [ ] **Step 3: Implement the helper**

Append to `apps/server/web/src/lib/preset-form.ts`:

```ts
/**
 * Suggests a clone name for a preset: the source name with the first free
 * numeric suffix — `"<name> (2)"`, `(3)`, …, the convention migration 0028
 * used to break the collisions it found. Taken-ness is scoped to rows of the
 * SAME harness (the UNIQUE index is `(user_id, harness_id, name
 * COLLATE NOCASE)`) and compared case-insensitively, so the suggestion
 * matches what `POST /api/presets` would reject. The loop is bounded because
 * names are unique per harness, so at most `taken.size` candidates can be
 * taken — one more number is always free.
 *
 * @param rows - The caller's preset list (the `usePresets()` cache)
 * @param source - The preset being cloned (its own row never blocks)
 * @returns A name free for this user's preset of the same harness
 */
export function suggestCloneName(rows: PresetRow[], source: PresetRow): string {
  const taken = new Set(
    rows
      .filter((r) => r.harnessId === source.harnessId && r.id !== source.id)
      .map((r) => r.name.toLowerCase()),
  );
  for (let n = 2; n <= taken.size + 2; n++) {
    const candidate = `${source.name} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Unreachable while the index holds: taken.size names cannot fill
  // taken.size + 1 candidates.
  return `${source.name} (${taken.size + 2})`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/theo/projects/subshell/apps/server/web && bun test src/lib/__tests__/preset-form.test.ts`
Expected: all PASS (including the file's pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/lib/preset-form.ts apps/server/web/src/lib/__tests__/preset-form.test.ts
git commit -m "feat(server-web): suggestCloneName proposes a collision-free preset clone name"
```

---

### Task 2: `initialForm` posture on `CreatePresetDialog`

**Files:**
- Modify: `apps/server/web/src/components/presets/create-preset-dialog.tsx`
- Test: `apps/server/web/src/components/__tests__/create-preset-dialog.test.tsx` (new file; the dialog's subtree needs no router — verified: neither it nor `preset-fields.tsx` / `command-paste-field.tsx` / `mcp-setup-section.tsx` / `pair-rows-editor.tsx` import `react-router`)

**Interfaces:**
- Consumes: `PresetFormValue` from `@/lib/preset-form`; existing `useCreatePreset` (`POST /api/presets`), `useInstancePlugins` (`GET /api/plugins`), `useHarnessSchema` (`GET /api/presets/harnesses/:id/schema`).
- Produces: prop `initialForm?: PresetFormValue` on `CreatePresetDialog` — when present, the form's initial state IS that value and the header reads "Clone preset". Task 3 passes `{ ...presetFormFromRow(source), name: suggestCloneName(...) }`.

- [ ] **Step 1: Write the failing component test**

Create `apps/server/web/src/components/__tests__/create-preset-dialog.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreatePresetDialog } from "@/components/presets/create-preset-dialog";
import { type PresetFormValue, presetFormFromRow } from "@/lib/preset-form";
import type { PresetRow } from "@/types/preset";

/** A stored preset with one env var, one flag, and auto-restart on. */
const SOURCE: PresetRow = {
  id: "src-1",
  harnessId: "claude-code",
  name: "Work",
  description: null,
  envJson: '{"ANTHROPIC_MODEL":"sonnet"}',
  flagsJson: '["--effort","xhigh"]',
  settingsJson: null,
  configIsolation: 0,
  restartOnExit: 1,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};

/** Records every fetch (JSON bodies parsed); the catalog answers with one
 *  agent so the locked posture has a name to show; the POST echoes a row. */
function mockFetch() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.pathname === "/api/plugins")
      return Promise.resolve(
        new Response(
          JSON.stringify({
            plugins: [
              {
                id: "claude-code",
                name: "Claude Code",
                description: "",
                installed: true,
                enabled: true,
                builtIn: true,
              },
            ],
          }),
        ),
      );
    if (url.pathname === "/api/presets" && method === "POST")
      return Promise.resolve(new Response(JSON.stringify({ ...SOURCE, id: "new-1" })));
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Renders the dialog (no router needed) settled, so the catalog and schema
 *  reads have landed before the caller asserts (repo pattern from
 *  clone-subshell-dialog.test.tsx). */
async function renderDialog(props: { lockedHarness?: string; initialForm?: PresetFormValue }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CreatePresetDialog open onOpenChange={() => {}} {...props} />
    </QueryClientProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe("CreatePresetDialog", () => {
  afterEach(cleanup);

  it("an initialForm seeds the form, keeps the locked agent, and titles the dialog Clone preset", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderDialog({
        lockedHarness: SOURCE.harnessId,
        initialForm: { ...presetFormFromRow(SOURCE), name: "Work (2)" },
      });
      expect(await screen.findByRole("heading", { name: "Clone preset" })).toBeDefined();
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Work (2)");
      // Locked posture: the agent shows as static text naming itself.
      expect(screen.getByText("Claude Code")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Create preset" }));
      await waitFor(() =>
        expect(calls.some((c) => c.method === "POST" && c.url === "/api/presets")).toBe(true),
      );
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/presets");
      // The payload is a plain create carrying the seeded fields: harness
      // preserved, name suggested, env/flags/restart copied, no description.
      expect(post?.body).toMatchObject({
        harnessId: "claude-code",
        name: "Work (2)",
        env: { ANTHROPIC_MODEL: "sonnet" },
        flags: ["--effort", "xhigh"],
        restartOnExit: true,
      });
    } finally {
      restore();
    }
  });

  it("without initialForm the create posture and its title are untouched", async () => {
    const { restore } = mockFetch();
    try {
      await renderDialog({});
      expect(await screen.findByRole("heading", { name: "Create preset" })).toBeDefined();
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    } finally {
      restore();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/theo/projects/subshell/apps/server/web && bun test src/components/__tests__/create-preset-dialog.test.tsx`
Expected: FAIL — TypeScript won't reject the unknown prop at runtime, so the first assertion fails: no "Clone preset" heading, and the POST never carries the seeded fields.

- [ ] **Step 3: Implement the posture**

In `apps/server/web/src/components/presets/create-preset-dialog.tsx`:

Add the prop (after `lockedHarness`) and the state seed:

```ts
  /** The clone posture: form values carried over from an existing preset
   * (seeded name/env/flags/restart). The caller also passes
   * `lockedHarness` = the source's, because a preset's harness is immutable
   * and a clone stays with its agent. The POST is still a plain create. */
  initialForm?: PresetFormValue;
```

```ts
  const [form, setForm] = useState<PresetFormValue>(() =>
    initialForm !== undefined
      ? initialForm
      : lockedHarness
        ? { ...emptyPresetForm(), harnessId: lockedHarness }
        : emptyPresetForm(),
  );
```

And the title — replace the single `DialogTitle` expression:

```tsx
  <DialogTitle>
    {initialForm !== undefined
      ? "Clone preset"
      : lockedHarness !== undefined
        ? `New preset for ${lockedName}`
        : "Create preset"}
  </DialogTitle>
```

Extend the component's doc comment: it lists "two postures (spec 2026-09-13 §5)" — say the `initialForm` seed is the third, clone one, and that "Mount IS the open" means a second Clone starts from a fresh seed of the then-current source.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/theo/projects/subshell/apps/server/web && bun test src/components/__tests__/create-preset-dialog.test.tsx`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/components/presets/create-preset-dialog.tsx apps/server/web/src/components/__tests__/create-preset-dialog.test.tsx
git commit -m "feat(server-web): CreatePresetDialog takes an initialForm and reads Clone preset"
```

---

### Task 3: menu item, page wiring, and the e2e round trip

**Files:**
- Modify: `apps/server/web/src/routes/presets.tsx`
- Test: `e2e/tests/04-presets.spec.ts` (add a test + extend the cleanup name list)

**Interfaces:**
- Consumes: `suggestCloneName(rows, source)` (Task 1), `presetFormFromRow(row)` (existing), `CreatePresetDialog`'s `initialForm` + `lockedHarness` props (Task 2), `PresetListRow`'s `items: ActionItem[]` (existing), `usePresets()` cache `presets` (existing).
- Produces: the shipped feature; no later task depends on it.

- [ ] **Step 1: Write the failing e2e test**

In `e2e/tests/04-presets.spec.ts`: extend the cleanup list at the top:

```ts
const CREATED_BY_THIS_SPEC = ["E2E shell", "Inline shell", "E2E clone source", "E2E clone source (2)"];
```

Append this test at the end of the file:

```ts
test("clone a preset from the row's action menu", async ({ page }) => {
  await page.goto("/presets");
  await page.getByRole("button", { name: "New preset" }).click();
  await page.locator("#preset-harness").click();
  await page.getByRole("option", { name: "pi", exact: true }).click();
  await page.fill("#preset-name", "E2E clone source");
  await page.getByRole("button", { name: "Create preset" }).click();
  await expect(page.getByText("E2E clone source", { exact: true })).toBeVisible();

  // The row menu's Clone opens the create dialog SEEDED: same agent (locked,
  // so no #preset-harness here), suggested collision-free name.
  await page.getByRole("button", { name: "Actions for E2E clone source" }).click();
  await page.getByRole("menuitem", { name: "Clone preset" }).click();
  await expect(page.getByRole("heading", { name: "Clone preset" })).toBeVisible();
  await expect(page.locator("#preset-name")).toHaveValue("E2E clone source (2)");
  await expect(page.locator("#preset-harness")).toHaveCount(0);
  await page.getByRole("button", { name: "Create preset" }).click();
  await expect(page.getByText("E2E clone source (2)", { exact: true })).toBeVisible();

  // Both rows persisted, same harness, distinct names.
  const stored = await page.evaluate(async () => {
    const rows = (await (await fetch("/api/presets")).json()) as { name: string; harnessId: string }[];
    return rows
      .filter((r) => r.name.startsWith("E2E clone source"))
      .map((r) => [r.name, r.harnessId] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
  });
  expect(stored).toEqual([
    ["E2E clone source", "pi"],
    ["E2E clone source (2)", "pi"],
  ]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/theo/projects/subshell/e2e && bun run test:e2e tests/04-presets.spec.ts`
(Boots its own backend on :3199 with real tmux; needs the one-time `bunx playwright install chromium` if never run here.)
Expected: FAIL at `getByRole("menuitem", { name: "Clone preset" })` — the menu has no such item.

- [ ] **Step 3: Wire the page**

In `apps/server/web/src/routes/presets.tsx`:

Imports — extend the lucide line to include `Copy`, and add the form-model import:

```ts
import { Copy, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { presetFormFromRow, suggestCloneName } from "@/lib/preset-form";
```

State — beside `showCreate`:

```ts
  // The row whose Clone dialog is open; the dialog mounts only while set
  // (clone-dialog posture), so every open re-seeds from the then-current row.
  const [cloneSource, setCloneSource] = useState<PresetRow | null>(null);
```

Menu item — between Edit and Delete in the `items` array:

```ts
                      {
                        label: "Clone preset",
                        icon: Copy,
                        onSelect: () => setCloneSource(p),
                      },
```

Mount — after the existing `{showCreate && <CreatePresetDialog …/>}` line:

```tsx
      {cloneSource && (
        <CreatePresetDialog
          open
          onOpenChange={(next) => !next && setCloneSource(null)}
          lockedHarness={cloneSource.harnessId}
          initialForm={{
            ...presetFormFromRow(cloneSource),
            name: suggestCloneName(presets ?? [], cloneSource),
          }}
        />
      )}
```

- [ ] **Step 4: Run the e2e file to verify it passes**

Run: `cd /home/theo/projects/subshell/e2e && bun run test:e2e tests/04-presets.spec.ts`
Expected: all tests in the file PASS (including the pre-existing two).

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/routes/presets.tsx e2e/tests/04-presets.spec.ts
git commit -m "feat(server-web): Clone preset in the row menu opens a seeded create dialog"
```

---

### Task 4: full verification and the changeset

**Files:**
- Create: `.changeset/clone-preset-menu.md` (repo root)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a green tree ready for review.

- [ ] **Step 1: Run the three standing checks from the repo root**

```bash
bun run verify-types
bun run lint:check
bun run test
```
Expected: all three PASS. Fix anything they report before proceeding (biome may want a format — `bun run lint` fixes, then re-check).

- [ ] **Step 2: Add the changeset**

`@internal/server-web` is changesets-IGNORED (the SPA ships embedded in the server), so per the repo's rule the note belongs to the app that ships it. Create `.changeset/clone-preset-menu.md` (repo root `.changeset/`):

```markdown
---
"@internal/server": minor
---

Presets: the row action menu gains Clone preset. It opens the create dialog prefilled from the source (same agent, its env, flags, and restart policy) with the next free "(2)" name suggested.
```

- [ ] **Step 3: Commit**

```bash
git add .changeset/clone-preset-menu.md
git commit -m "chore: changeset for preset clone"
```

Expected: pre-commit hook passes (the changeset is not a `@internal/server-web` reference — an ignored package in a changeset would wedge the version PR; this names the releasable app).

---

## Self-review notes (author, post-writing)

- Spec coverage: helper (§suggestCloneName) → Task 1; dialog posture + title → Task 2; menu item + mount + 409-path left unchanged → Task 3 (the 409 inline behavior is pre-existing and needs no new test); description-not-carried → asserted implicitly in Task 2's `toMatchObject` payload (no `description` key is sent, and `PresetPayload` has no such field); e2e round trip → Task 3; changeset per repo rule → Task 4.
- Type consistency: `suggestCloneName(rows: PresetRow[], source: PresetRow): string` named identically in Tasks 1 and 3; `initialForm: PresetFormValue` identical in Tasks 2 and 3; `presetFormFromRow` is the existing export, unmodified.
