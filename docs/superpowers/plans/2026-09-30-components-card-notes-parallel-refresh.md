# Components Card: Notes, Parallel Update all, Refresh Resume - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Components update table gains Notes links on its CLI rows, fires "Update all" in parallel, and keeps an in-flight update's story across a page refresh.

**Architecture:** All changes live in the server admin SPA (`apps/server/web`). One pure poll-gate function (`lib/updates-poll.ts`) decides refetch cadence from server facts; the node rows take their busy state from the server-side tracker mirrored into `GET /api/admin/updates`; the update hook stops being a single-call `useMutation` so a batch of presses can coexist.

**Tech Stack:** React 19, TanStack Query 5, bun:test + @testing-library/react (happy-dom), Tailwind with design tokens.

Spec: `docs/superpowers/specs/2026-09-30-components-card-notes-parallel-refresh-design.md`. Branch `fix/components-update-card-notes-parallel-refresh` is already checked out.

## Global Constraints

- Only `apps/server/web` changes. No route, schema, package, or CLI changes; no new dependencies.
- No dynamic `await import()` anywhere.
- UI copy: the literal label `Notes`, no em dash (U+2014) in any prose or shipped string (`bun run lint:prose` enforces).
- Help/detail copy uses the `text-detail` role token; the Notes anchor copies the desktop rows' classes verbatim: `text-detail underline hover:text-foreground`.
- Focused verification per task: `bun test <changed test files>` (check the printed file count; bun silently skips paths that do not exist), `bunx turbo verify-types --filter=@internal/server-web`, `bunx biome check <changed paths>` (fix with `bun run lint` if needed).
- Commit per task; conventional prefixes, as the repo log uses them.

---

### Task 1: Move `releasePageUrl` into the shared row cells

Pure relocation so the Server row, the Nodes section, and the desktop rows share one definition. `desktop-rows.tsx:7` currently owns it; its only importer is its own test.

**Files:**
- Modify: `apps/server/web/src/components/updates/row-cells.tsx`
- Modify: `apps/server/web/src/components/updates/desktop-rows.tsx` (remove the definition, import it)
- Modify: `apps/server/web/src/components/__tests__/updates-desktop-rows.test.tsx:4` (import path)

**Interfaces:**
- Consumes: nothing new.
- Produces: `releasePageUrl(tag: string): string` exported from `@/components/updates/row-cells` (Tasks 2 and 4 import it from there).

- [ ] **Step 1: Update the test's import (this is the failing state)**

In `apps/server/web/src/components/__tests__/updates-desktop-rows.test.tsx`, change line 4 from

```ts
import { DesktopRows, releasePageUrl } from "@/components/updates/desktop-rows";
```

to

```ts
import { DesktopRows } from "@/components/updates/desktop-rows";
import { releasePageUrl } from "@/components/updates/row-cells";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/server/web/src/components/__tests__/updates-desktop-rows.test.tsx`
Expected: FAIL, "releasePageUrl" is not exported from row-cells (SyntaxError on import).

- [ ] **Step 3: Add the function to `row-cells.tsx`**

At the top of `apps/server/web/src/components/updates/row-cells.tsx`, above the existing module doc comment, add the import, and after the `DASH` constant add:

```ts
import { SUBSHELL_REPO_SLUG } from "@internal/subshell-protocol";
```

```ts
/** Where a release's own page lives, for every browser-surface link in this
 * table (desktop rows, the Server row, the Nodes section). One definition:
 * a tag-to-URL rule that drifts per row would point rows at the wrong repo. */
export function releasePageUrl(tag: string): string {
  return `https://github.com/${SUBSHELL_REPO_SLUG}/releases/tag/${tag}`;
}
```

- [ ] **Step 4: Remove the old definition and import it in `desktop-rows.tsx`**

In `apps/server/web/src/components/updates/desktop-rows.tsx`: delete lines 6-9 (the doc comment and `export function releasePageUrl`), and change line 1 to keep `semverLt` while pulling the function from the cells file:

```ts
import { semverLt } from "@internal/subshell-protocol";
import { DASH, MobilePair, releasePageUrl, RowRule, VersionCell } from "@/components/updates/row-cells";
```

(Keep the rest of its existing import list; `DASH`, `MobilePair`, `RowRule`, `VersionCell` were already imported from row-cells.)

- [ ] **Step 5: Run tests to verify green**

Run: `bun test apps/server/web/src/components/__tests__/updates-desktop-rows.test.tsx`
Expected: PASS, all cases (import moved, behavior unchanged).

- [ ] **Step 6: Verify and commit**

```bash
bunx turbo verify-types --filter=@internal/server-web
bunx biome check apps/server/web/src/components/updates/row-cells.tsx apps/server/web/src/components/updates/desktop-rows.tsx apps/server/web/src/components/__tests__/updates-desktop-rows.test.tsx
git add apps/server/web/src/components/updates/row-cells.tsx apps/server/web/src/components/updates/desktop-rows.tsx apps/server/web/src/components/__tests__/updates-desktop-rows.test.tsx
git commit -m "refactor(web): move releasePageUrl into the shared Components row cells"
```

---

### Task 2: Notes link on the Server row

`ServerRow` renders in browsers only (`updates-table.tsx:111`), so the browser-only Notes rule is satisfied by placing the link there at all.

**Files:**
- Modify: `apps/server/web/src/components/updates/server-row.tsx` (imports + action cell, around line 136)
- Test: `apps/server/web/src/components/__tests__/updates-server-row.test.tsx`

**Interfaces:**
- Consumes: `releasePageUrl` from `@/components/updates/row-cells` (Task 1).
- Produces: nothing later tasks consume; the DOM gains `link "Notes"` in the Server row's action cell whenever `view.latest !== null`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/web/src/components/__tests__/updates-server-row.test.tsx` (inside the first `describe`, reusing its local `renderRow` and the existing `serverUpdateView` import):

```tsx
describe("the Server row's Notes link", () => {
  it("links the release page of the version its Newest cell names", () => {
    renderRow(serverUpdateView());
    const link = screen.getByRole("link", { name: "Notes" }) as HTMLAnchorElement;
    expect(link.href).toBe(releasePageUrl("cli-server-v0.7.0"));
    expect(link.target).toBe("_blank");
  });

  it("links even when this server is already newest: the notes describe the release, not the act", () => {
    renderRow(
      serverUpdateView({ updateAvailable: false, latest: { version: "0.6.0", tag: "cli-server-v0.6.0", publishedAt: null } }),
    );
    expect(screen.getByRole("link", { name: "Notes" })).toBeTruthy();
  });

  it("offers no link when the release source named nothing", () => {
    renderRow(serverUpdateView({ latest: null, updateAvailable: false }));
    expect(screen.queryByRole("link", { name: "Notes" })).toBeNull();
  });
});
```

Add to the file's imports:

```ts
import { releasePageUrl } from "@/components/updates/row-cells";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/server/web/src/components/__tests__/updates-server-row.test.tsx`
Expected: FAIL, two cases cannot find `link "Notes"`; the file count line shows the file ran.

- [ ] **Step 3: Render the link in `server-row.tsx`**

Add to the imports (the file already imports several names from the cells module):

```ts
import { DASH, MobilePair, releasePageUrl, VersionCell } from "@/components/updates/row-cells";
```

Inside the action cell `<div className="flex flex-wrap items-center justify-end gap-2">` (currently around line 136), BEFORE the `<Button>`, add:

```tsx
{/* The release page of exactly what the Newest cell names, beside the act
    that would install it (operator request 2026-09-30: the CLI rows read
    their notes nowhere while the desktop rows linked theirs). Shown even
    when up to date: the notes describe the release, not the act. */}
{view.latest !== null && (
  <a
    href={releasePageUrl(view.latest.tag)}
    target="_blank"
    rel="noreferrer"
    className="text-detail underline hover:text-foreground"
  >
    Notes
  </a>
)}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/server/web/src/components/__tests__/updates-server-row.test.tsx apps/server/web/src/components/__tests__/updates-table.test.tsx`
Expected: PASS in both files (file count 2; the table test also renders this row), including every pre-existing case.

- [ ] **Step 5: Verify and commit**

```bash
bunx turbo verify-types --filter=@internal/server-web
bunx biome check apps/server/web/src/components/updates/server-row.tsx apps/server/web/src/components/__tests__/updates-server-row.test.tsx
git add apps/server/web/src/components/updates/server-row.tsx apps/server/web/src/components/__tests__/updates-server-row.test.tsx
git commit -m "feat(web): Notes link on the Server row of the Components table"
```

---

### Task 3: A live server job keeps the page polling (the refresh fix)

Root cause (spec item 3): the self tracker entry begins only at the swap, so between a refresh and the swap nothing raises the poll cadence and the job line freezes. The job itself is already server state in the payload; the gate must read it.

**Files:**
- Modify: `apps/server/web/src/lib/updates-poll.ts:33-38` (`updatesPollMs`)
- Test: `apps/server/web/src/lib/__tests__/updates-poll.test.ts`

**Interfaces:**
- Consumes: `ServerUpdateView.job: UpdateJob | null` (already in `@/types/updates`).
- Produces: `updatesPollMs` returning `2_000` while `view.server.job` is in a non-`failed` phase; signature unchanged, so `use-updates.ts` needs no edit.

- [ ] **Step 1: Write the failing tests**

In `apps/server/web/src/lib/__tests__/updates-poll.test.ts`: extend the helper import to `nodeRow, nodeUpdates, serverUpdateView, updatesView` from `@/components/__tests__/helpers/updates-view`, extend the type import to `UpdateJob, UpdateTrackerState` from `@/types/updates`, add a local job builder beside the existing `state` helper, and append these cases inside the `describe`:

```ts
/** The in-process server job, at one phase, everything else at rest. */
function job(over: Partial<UpdateJob> = {}): UpdateJob {
  return {
    from: "0.6.0",
    to: "0.7.0",
    startedAt: "2026-09-30T12:00:00.000Z",
    phase: "downloading",
    received: 0,
    total: null,
    error: null,
    ...over,
  };
}

it("polls while the server's own job is running: the self tracker entry starts only at the swap", () => {
  // The refresh bug this gate closes: a page reloaded mid-download had no
  // live tracker entry to see, answered false forever, and rendered the
  // job line frozen at the moment of load. The job is a server fact in the
  // same payload, so the gate can read it.
  for (const phase of ["downloading", "verifying", "backing-up", "swapping", "restarting"] as const) {
    const view = updatesView({ server: serverUpdateView({ job: job({ phase }) }) });
    expect(updatesPollMs(view, false)).toBe(2_000);
  }
});

it("stops polling on a failed job, which stays visible until the next start", () => {
  const view = updatesView({ server: serverUpdateView({ job: job({ phase: "failed", error: "no reason" }) }) });
  expect(updatesPollMs(view, false)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/server/web/src/lib/__tests__/updates-poll.test.ts`
Expected: FAIL, "polls while the server's own job is running" gets `false` instead of `2_000`. The `failed` case already passes (correct answer, wrong route there for now).

- [ ] **Step 3: Add the gate**

In `apps/server/web/src/lib/updates-poll.ts`, inside `updatesPollMs`, after the `view === undefined` line and BEFORE the `isLive(view.serverUpdate)` line, insert:

```ts
// A live SERVER JOB is a "something is moving" the tracker cannot say: the
// self entry is opened at the swap (server-update.ts), so for the whole
// download-verify-backup stretch the job is the only fact. Reading it here
// is what lets a page REFRESHED mid-download keep counting MB instead of
// rendering a frozen line; when the server exits for its restart, this
// same gate keeps the query refetching into the outage until the new boot
// answers with the terminal tracker entry. (Operator report 2026-09-30:
// "why do I lose current update status when I refresh the page".)
if (view.server.job !== null && view.server.job.phase !== "failed") return ACTIVE_POLL_MS;
```

Update the function's doc comment: where it says "what the server-side tracker added", extend one sentence to note the job gate is the same server-decided rule for the pre-swap window.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/server/web/src/lib/__tests__/updates-poll.test.ts`
Expected: PASS, all pre-existing cases plus the two new ones.

- [ ] **Step 5: Verify and commit**

```bash
bunx turbo verify-types --filter=@internal/server-web
bunx biome check apps/server/web/src/lib/updates-poll.ts apps/server/web/src/lib/__tests__/updates-poll.test.ts
git add apps/server/web/src/lib/updates-poll.ts apps/server/web/src/lib/__tests__/updates-poll.test.ts
git commit -m "fix(web): keep a refreshed Updates page polling while the server job runs"
```

---

### Task 4: Parallel Update all, tracker-owned row spinners, Nodes section Notes

One commit because the three files share one contract: the hook's per-node state (`pendingNodeIds`, `failures`), the rows that read it plus the tracker, and the node page card that reads the same hook. Changing the hook alone would leave a consumer calling removed fields; changing rows alone could not express a batch.

**Files:**
- Modify: `apps/server/web/src/hooks/use-node-update.ts` (rewrite body and interface)
- Modify: `apps/server/web/src/components/updates/node-rows.tsx` (rewrite; keeps `rowState` and `updateLine` unchanged)
- Modify: `apps/server/web/src/components/nodes/node-update-card.tsx:29,95-99` (field switch)
- Test: `apps/server/web/src/components/__tests__/updates-node-rows.test.tsx` (replace three sequence tests, add five cases)

**Interfaces:**
- Consumes: `releasePageUrl` from row-cells (Task 1); `UpdateTrackerState.phase` values `"working" | "restarting"` (already on the wire).
- Produces:

```ts
interface NodeUpdate {
  update(nodeId: string, opts?: { force?: boolean }): Promise<NodeUpdateStarted>;
  pendingNodeIds: ReadonlySet<string>;
  failures: Readonly<Record<string, string>>;
  reset(): void;
}
```

`pendingNodeId` and `failure` no longer exist; `node-update-card.tsx` and `node-rows.tsx` are their only consumers.

- [ ] **Step 1: Rewrite the failing sequence tests**

In `apps/server/web/src/components/__tests__/updates-node-rows.test.tsx`, add to imports: `releasePageUrl` from `@/components/updates/row-cells`. Then:

REPLACE the test `"shows Update all as Updating with a spinner while its sequence runs"` with:

```tsx
it("shows Update all as Updating with a spinner while its batch runs", async () => {
  // Parallel by contract now (spec 2026-09-30): the whole batch is asked at
  // once, and the header button says so while anything is still settling.
  const original = globalThis.fetch;
  const posts: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push(url);
      return new Promise<Response>(() => {}); // never resolves: the batch stays open
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  try {
    renderRows(
      nodeUpdates({
        rows: [
          nodeRow({ id: "a", name: "alpha", canUpdate: { ok: true, reason: null } }),
          nodeRow({ id: "b", name: "beta", canUpdate: { ok: true, reason: null } }),
        ],
      }),
    );
    const allBtn = updateAll();
    fireEvent.click(allBtn);
    // The whole point: BOTH machines were asked while the first is still
    // answering. Sequential dispatch left posts at length 1.
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts).toContain("/api/nodes/a/update");
    expect(posts).toContain("/api/nodes/b/update");
    expect(allBtn.textContent).toBe("Updating…");
    expect(allBtn.disabled).toBe(true);
    expect(allBtn.querySelector("svg")).toBeTruthy();
    // Header and both rows: three spinners for one fact, the fleet moving.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Updating…" }).length).toBe(3));
  } finally {
    globalThis.fetch = original;
  }
});
```

REPLACE the test `"moves the working row with the sequence and names its position"` with:

```tsx
it("runs each row to its own end and keeps a settled row spinning from the tracker alone", async () => {
  // The tracker-on-refresh contract (spec 2026-09-30): a row's busy state
  // comes from the server's fact, so the tab that sees a row's POST answer
  // still spins it while the tracker calls it live, and a reader who never
  // pressed reads the same spin.
  const original = globalThis.fetch;
  const deferred = new Map<string, () => void>();
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const id = url.split("/")[3];
      return new Promise<Response>((resolve) => {
        deferred.set(id, () =>
          resolve(
            new Response(JSON.stringify({ ok: true, from: "0.9.0", to: "0.9.1", url: "/d/linux-x64" }), {
              status: 202,
            }),
          ),
        );
      });
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof globalThis.fetch;
  try {
    const fleetA = nodeUpdates({
      release: { version: "0.9.1", tag: "cli-node-v0.9.1", publishedAt: null },
      rows: [
        nodeRow({ id: "a", name: "alpha", agentVersion: "0.9.0", canUpdate: { ok: true, reason: null } }),
        nodeRow({ id: "b", name: "beta", agentVersion: "0.9.0", canUpdate: { ok: true, reason: null } }),
      ],
    });
    const view = renderRows(fleetA);
    const allBtn = updateAll();
    fireEvent.click(allBtn);

    // Both in flight at once, both spinning, plus the header.
    await waitFor(() => expect(deferred.size).toBe(2));
    expect(screen.getAllByRole("button", { name: "Updating…" }).length).toBe(3);

    // a's 202 lands. Its POST settles, the payload knows nothing yet, so a
    // plainly waits while b keeps moving; the batch (and its lock) stays on.
    await act(async () => {
      deferred.get("a")?.();
    });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Updating…" }).length).toBe(2));
    expect(screen.getByRole("button", { name: "Update" }).textContent).toBe("Update");
    expect(allBtn.textContent).toBe("Updating…");

    // The mid-run refetch: a's tracker entry has appeared, a is offline and
    // out of the updatable list, b is still in flight. a's spinner and
    // sentence now come FROM THE PAYLOAD, not this tab's memory - that is
    // what a refreshed page would read too.
    view.rerender(
      <QueryClientProvider client={view.client}>
        <div className="grid">
          <NodeRows
            fleet={nodeUpdates({
              release: { version: "0.9.1", tag: "cli-node-v0.9.1", publishedAt: null },
              rows: [
                nodeRow({
                  id: "a",
                  name: "alpha",
                  agentVersion: "0.9.0",
                  canUpdate: { ok: false, reason: "this node is offline" },
                  update: updateState({ phase: "restarting" }),
                }),
                nodeRow({ id: "b", name: "beta", agentVersion: "0.9.0", canUpdate: { ok: true, reason: null } }),
              ],
            })}
          />
        </div>
      </QueryClientProvider>,
    );
    expect(screen.getByText("alpha is installing 0.9.1 and will reconnect by itself.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Updating…" }).length).toBe(3); // a is spinning again

    // b's 202 lands: the batch closes and the header is itself again, but
    // still LOCKED, because a's tracker says a is still moving.
    await act(async () => {
      deferred.get("b")?.();
    });
    await waitFor(() => expect(allBtn.textContent).toBe("Update all (1)"));
    expect(allBtn.disabled).toBe(true);
    view.rerender(
      <QueryClientProvider client={view.client}>
        <div className="grid">
          <NodeRows
            fleet={nodeUpdates({
              release: { version: "0.9.1", tag: "cli-node-v0.9.1", publishedAt: null },
              rows: [
                nodeRow({
                  id: "a",
                  name: "alpha",
                  agentVersion: "0.9.0",
                  canUpdate: { ok: false, reason: "this node is offline" },
                  update: updateState({ phase: "restarting" }),
                }),
                nodeRow({
                  id: "b",
                  name: "beta",
                  agentVersion: "0.9.0",
                  canUpdate: { ok: true, reason: null },
                  update: updateState({ phase: "restarting" }),
                }),
              ],
            })}
          />
        </div>
      </QueryClientProvider>,
    );
    expect(screen.getByText("beta is installing 0.9.1 and will reconnect by itself.")).toBeTruthy();
  } finally {
    globalThis.fetch = original;
  }
});
```

REPLACE the test `"says a failed 'Update all' ONCE, on the row it stopped at"` with:

```tsx
it("says a failed 'Update all' ONCE per failing row and asks them all anyway", async () => {
  // Parallel contract (spec 2026-09-30): a refusal no longer stops the
  // batch, because every row's story is its own - the tracker tells the
  // ones that opened an entry, this tab's failure map the ones refused
  // before one. The 2026-09-17 lesson survives in the COUNT: one failing
  // row shows its refusal exactly once.
  const original = globalThis.fetch;
  const posts: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push(url);
      return new Response("NODE_NOT_SUPERVISED: nothing respawns this agent", { status: 409 });
    }
    return original(input as RequestInfo, init);
  }) as unknown as typeof globalThis.fetch;
  try {
    renderRows(
      nodeUpdates({
        rows: [
          nodeRow({ id: "a", name: "alpha", canUpdate: { ok: true, reason: null } }),
          nodeRow({ id: "b", name: "beta", canUpdate: { ok: true, reason: null } }),
        ],
      }),
    );
    fireEvent.click(updateAll());
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBe(2));
    expect(screen.getAllByText(/NODE_NOT_SUPERVISED/).length).toBe(2);
    expect(posts).toContain("/api/nodes/a/update");
    expect(posts).toContain("/api/nodes/b/update");
  } finally {
    globalThis.fetch = original;
  }
});
```

APPEND to `describe("NodeRows")`:

```tsx
it("keeps the row spinning and the fleet locked from the tracker alone, as a refreshed page reads it", () => {
  // No press, no fetch stub: one live tracker entry on the payload IS the
  // whole state, which is the point of it being server state.
  renderRows(
    nodeUpdates({
      rows: [
        nodeRow({
          id: "a",
          name: "alpha",
          canUpdate: { ok: true, reason: null },
          update: updateState({ phase: "restarting" }),
        }),
      ],
    }),
  );
  const rowBtn = screen.getByRole("button", { name: "Updating…" }) as HTMLButtonElement;
  expect(rowBtn.disabled).toBe(true);
  expect(updateAll().disabled).toBe(true);
});

it("hands a stalled row back to the human instead of locking the fleet on it", () => {
  // STALL_MS-not-busy: two minutes without confirmation and the row says
  // so; a permanently disabled button would take that handoff away.
  renderRows(
    nodeUpdates({
      rows: [
        nodeRow({
          id: "a",
          name: "alpha",
          canUpdate: { ok: true, reason: null },
          update: updateState({ phase: "stalled" }),
        }),
      ],
    }),
  );
  expect(updateAll().disabled).toBe(false);
  expect(screen.getByRole("button", { name: "Update" }).textContent).toBe("Update");
});

it("links the Nodes section to the offered node release", () => {
  // One link for the section, not one per row (operator ruling 2026-09-30):
  // every row is offered the same release page.
  renderRows(nodeUpdates({ rows: [nodeRow()] }));
  const link = screen.getByRole("link", { name: "Notes" }) as HTMLAnchorElement;
  expect(link.href).toBe(releasePageUrl("cli-node-v0.9.0"));
});

it("offers no Notes when no node release can be offered", () => {
  renderRows(nodeUpdates({ release: null, reason: "the release source is off", rows: [nodeRow()] }));
  expect(screen.queryByRole("link", { name: "Notes" })).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/server/web/src/components/__tests__/updates-node-rows.test.tsx`
Expected: FAIL on the batch tests (dispatch is still sequential, `posts.length` stuck at 1) and on the Notes link (no link rendered yet). The tracker-lock test fails too: the rows do not yet read busy from the tracker.

- [ ] **Step 3: Rewrite the hook**

Replace the whole of `apps/server/web/src/hooks/use-node-update.ts` below its license-free first import block with this (the `NodeUpdateStarted` interface is repeated here verbatim so the task is self-contained):

```ts
import { apiFetch, errMessage, NODE_QUERY_KEY, NODES_QUERY_KEY } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { UPDATES_QUERY_KEY } from "@/lib/query-keys";

/** What `POST /api/nodes/:id/update` answers on 202. */
export interface NodeUpdateStarted {
  ok: true;
  /** The node version that machine was running. */
  from: string;
  /** The version it is installing. */
  to: string;
  /**
   * The download URL the node was given, WITHOUT its single-use token. Echoed
   * because it is built from this server's `APP_BASE_URL` — the same base the
   * enroll script bakes, with the same loopback trap — so a page can warn
   * when a remote machine has been told to fetch from `127.0.0.1`.
   */
  url: string;
}

/** What {@link useNodeUpdate} hands the Nodes rows and the node page card. */
export interface NodeUpdate {
  /** Ask one node to replace its own binary. Resolves on the 202; rejects on a refusal. */
  update(nodeId: string, opts?: { force?: boolean }): Promise<NodeUpdateStarted>;
  /** Node ids whose POST is in flight through this hook instance. A SET,
   * because one instance now drives a whole batch: a single-call
   * `useMutation` could name only its latest variables, which is what left
   * every "Update all" but the first row silent for minutes (operator
   * report 2026-09-25, and the reason the old sequence owned its own
   * activeId - this makes that per-tab bookkeeping unnecessary). */
  pendingNodeIds: ReadonlySet<string>;
  /** Why a node's last attempt was REFUSED, per node. Covers the refusals
   * that land before the route opens a tracker entry (offline, too old,
   * would kill panes) and so have no server-side story; the tracker's
   * sentence wins wherever both exist (the rows' suppression rule). */
  failures: Readonly<Record<string, string>>;
  /** Forget every remembered failure - the rows clear them when a new run
   * starts, so a refusal from before never stays pinned on a row the new
   * run did not even ask. */
  reset(): void;
}

/**
 * `POST /api/nodes/:id/update` — replace one node's own binary (spec
 * 2026-09-15 §5.3).
 *
 * **This is the action a HELD node exists for.** A node the server refuses
 * for its version or protocol is no longer dropped — its socket is held open
 * for this one command — so `node.held` being non-null is precisely when this
 * is both possible and the only thing that helps. It also works on an online
 * node that is simply behind. `local` is a 400: the host updates with the
 * server. 409s carry the refusal: `NODE_OFFLINE`, `NODE_UPDATE_UNAVAILABLE`,
 * `NODE_AGENT_TOO_OLD` (remedy: `subshell update` at that machine),
 * `NODE_NOT_SUPERVISED`, `NODE_RESTART_KILLS_PANES` (`force` overrides) and
 * `NODE_UPDATE_FAILED` — on which the node's binary is untouched.
 *
 * **One instance drives many nodes at once** (spec 2026-09-30): "Update all"
 * fires its whole batch through this one hook, so busy and failure are
 * per-node collections, not a mutation's single latest call. It rejects
 * rather than swallowing, because the caller is a BATCH: `Promise.allSettled`
 * keeps every row's outcome independent, and a hook that resolved on a
 * refusal would report a stopped machine as a finished one.
 */
export function useNodeUpdate(): NodeUpdate {
  const queryClient = useQueryClient();
  const [pendingNodeIds, setPendingNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});

  async function update(nodeId: string, opts?: { force?: boolean }): Promise<NodeUpdateStarted> {
    setPendingNodeIds((cur) => new Set(cur).add(nodeId));
    setFailures((cur) => {
      if (cur[nodeId] === undefined) return cur;
      const next = { ...cur };
      delete next[nodeId];
      return next;
    });
    try {
      const result = await apiFetch<NodeUpdateStarted>(`/api/nodes/${nodeId}/update`, {
        method: "POST",
        body: JSON.stringify(opts?.force === true ? { force: true } : {}),
      });
      // The node exits to be respawned, so its row is about to change twice:
      // offline, then online on the new version.
      void queryClient.invalidateQueries({ queryKey: UPDATES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, nodeId] });
      return result;
    } catch (err) {
      setFailures((cur) => ({ ...cur, [nodeId]: errMessage(err, "The update was refused.") }));
      throw err;
    } finally {
      setPendingNodeIds((cur) => {
        if (!cur.has(nodeId)) return cur;
        const next = new Set(cur);
        next.delete(nodeId);
        return next;
      });
    }
  }

  function reset(): void {
    setFailures({});
  }

  return { update, pendingNodeIds, failures, reset };
}
```

- [ ] **Step 4: Rewrite the rows**

Replace `apps/server/web/src/components/updates/node-rows.tsx` with the following in full. `rowState` and `updateLine` are repeated verbatim so the task is self-contained; only everything from `isLive` down is new:

```tsx
import { Button } from "@internal/node-admin";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { DASH, MobilePair, releasePageUrl, RowRule, VersionCell } from "@/components/updates/row-cells";
import { useNodeUpdate } from "@/hooks/use-node-update";
import { endOnce } from "@/lib/update-copy";
import type { NodeUpdateRow, NodeUpdates, UpdateTrackerState } from "@/types/updates";

/**
 * What one row says about itself, in the fewest words that are true (spec §10).
 *
 * A HELD node is the interesting case and the reason the numbers travel with
 * the rows: "needs update" alone is unactionable, while "speaks protocol 9,
 * this server speaks 10" tells an operator which end is behind — and sometimes
 * the answer is the SERVER, which is the one conclusion a node-shaped sentence
 * would never reach.
 *
 * @param row - the node
 * @param fleet - the server's own floor and protocol, the other half of the sentence
 */
export function rowState(row: NodeUpdateRow, fleet: Pick<NodeUpdates, "minNodeVersion" | "protocol">): string {
  if (row.held?.reason === "below-floor") {
    return `needs update: below this server's minimum (${fleet.minNodeVersion})`;
  }
  if (row.held?.reason === "protocol-mismatch") {
    return `needs update: speaks protocol ${row.protocolVersion ?? "?"}, this server speaks ${fleet.protocol}`;
  }
  // The third refusal (spec 2026-09-24 ledger R3): a node that passed BOTH the
  // floor and the protocol but has no encryption pin. A held row whose reason is
  // neither of the two above can only be that one, so the test is a catch-all on
  // `held` rather than a `=== "encryption-required"` — the client's `HeldReason`
  // union lives in the Apache `@internal/node-admin` package (out of scope for
  // this change), and naming the new literal here would be an un-overlapping
  // comparison against a type that has not grown it. Same remedy the other chips
  // point at: the node updates and registers.
  if (row.held) {
    return "node needs to re-pair its encryption identity";
  }
  return row.online ? "online" : "offline";
}

/**
 * What one tracker entry says on its row, in the page's own words.
 *
 * The phase is SERVER state (design 2026-09-25: `update-tracker.ts` on the
 * server, mirrored into this payload), not component memory — which is what
 * lets a refreshed page, or a second admin tab, pick up an in-flight update
 * mid-sentence instead of after the fact. The older reason still stands too:
 * a node update's LAST act lands AFTER the POST answers (operator report,
 * 2026-09-23: "the update did work but it didn't update the version"), and
 * the tracker is now the thing that knows.
 */
function updateLine(row: NodeUpdateRow, update: UpdateTrackerState): string {
  switch (update.phase) {
    case "working":
    case "restarting":
      // One sentence for both live phases: to the page they are the same
      // fact, the machine is on its way; only the server knows which half.
      return `${row.name} is installing ${update.to} and will reconnect by itself.`;
    case "done":
      return `Updated to ${update.to}.`;
    case "failed":
      return `The update to ${update.to} did not land: ${update.message ?? "the node gave no reason"}.`;
    case "stalled":
      return `The update was accepted, but ${row.name} has not reported ${update.to} yet. It may still be restarting; reload to check.`;
  }
}

/**
 * Whether the server's tracker calls one node's update still moving.
 * `stalled` deliberately reads as NOT live: the row says its hedge and a
 * human takes over, and a spinner plus a locked button would take that
 * handoff back. Same reading the poll gate uses (`lib/updates-poll.ts`).
 */
function isLive(update: UpdateTrackerState | null): boolean {
  return update !== null && (update.phase === "working" || update.phase === "restarting");
}

/**
 * The fleet: what every enrolled node is running, and what it could run.
 *
 * **Update all fires every updatable row at once** (spec 2026-09-30). The
 * original sequence stopped at the first failure so a partial fleet could
 * not read as unexplained; the server tracker (design 2026-09-25) states
 * each machine's own story on its own row now, so the sequence protected a
 * silence that no longer exists - and nodes download from the plane, which
 * memoizes its own release fetch, so a parallel batch is N LAN reads, not
 * N hits on the release source. A dispatched update cannot be recalled,
 * which is what the old stop actually bought.
 *
 * A row is busy when the tracker says live, or this tab's POST is in
 * flight; the second covers only the window before the payload catches up,
 * the first is what keeps spinning and locking through a REFRESH or on a
 * tab that never pressed. `Update all` and every row button lock on that;
 * the tab's own batch additionally labels the header "Updating…".
 *
 * The section opens with a full-width rule carrying its label, the offered
 * release's Notes link (one for the section: every row is offered the same
 * release page), and Update all.
 */
export function NodeRows({ fleet }: { fleet: NodeUpdates }) {
  const nodeUpdate = useNodeUpdate();
  // True while THIS tab's batch has unsettled POSTs. Row busy no longer
  // reads this (the tracker owns busy); it only labels the header and keeps
  // the whole fleet locked while the tab's own press is half-dispatched.
  const [batch, setBatch] = useState(false);

  const updatable = fleet.rows.filter((row) => row.canUpdate.ok);
  const rowBusy = (row: NodeUpdateRow): boolean => nodeUpdate.pendingNodeIds.has(row.id) || isLive(row.update);
  const anyBusy = batch || fleet.rows.some(rowBusy);

  async function updateAll(): Promise<void> {
    // The run clears prior refusals first, or a refusal from before stays
    // pinned on a row this run never even asked.
    nodeUpdate.reset();
    setBatch(true);
    try {
      // allSettled, not all: every row's outcome owns its own row, and one
      // rejection must not silence, or march past, the others.
      await Promise.allSettled(updatable.map((row) => nodeUpdate.update(row.id)));
    } finally {
      setBatch(false);
    }
  }

  const newest = fleet.release?.version ?? DASH;

  return (
    <>
      <div className="col-span-full flex flex-wrap items-center justify-between gap-3 border-t pt-2">
        <span className="font-strong text-label">Nodes</span>
        <div className="flex items-center gap-3">
          {fleet.release !== null && (
            <a
              href={releasePageUrl(fleet.release.tag)}
              target="_blank"
              rel="noreferrer"
              className="text-detail underline hover:text-foreground"
            >
              Notes
            </a>
          )}
          {fleet.rows.length > 0 && (
            <Button variant="outline" disabled={updatable.length === 0 || anyBusy} onClick={() => void updateAll()}>
              {batch && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 motion-safe:animate-spin" />}
              {batch ? "Updating…" : `Update all (${updatable.length})`}
            </Button>
          )}
        </div>
      </div>

      {fleet.release === null && (
        <p className="col-span-full text-detail text-muted-foreground">
          No node release can be offered: {endOnce(fleet.reason ?? "no reason was given")}
        </p>
      )}

      {fleet.rows.length === 0 && (
        <p className="col-span-full text-muted-foreground text-sm">No machines are enrolled as nodes.</p>
      )}

      {fleet.rows.map((row, index) => {
        const runningValue = row.agentVersion ?? "version unknown";
        // Busy FIRST from the server's fact, then this tab's POST: the
        // spinner survives the refresh, the second covers the gap before
        // the payload catches up.
        const updating = rowBusy(row);
        // The tracker entry rides the row (design 2026-09-25): every
        // sentence about an ordered update comes from the server's fact,
        // so a refresh or a second tab reads the same story mid-flight.
        const tracked = row.update;
        const failure = nodeUpdate.failures[row.id];
        return (
          <div key={row.id} className="contents">
            {index > 0 && <RowRule />}
            <div className="min-w-0">
              <p className="truncate font-strong text-label">{row.name}</p>
              <p className="truncate text-detail text-muted-foreground">
                {row.target ?? "no published platform"} · {rowState(row, fleet)}
              </p>
              <MobilePair running={runningValue} newest={newest} />
            </div>
            <VersionCell value={runningValue} />
            <VersionCell value={newest} />
            <div className="flex items-center justify-end">
              <Button
                variant="outline"
                size="sm"
                disabled={!row.canUpdate.ok || batch || updating}
                title={row.canUpdate.reason ?? undefined}
                onClick={() => {
                  nodeUpdate.reset();
                  void nodeUpdate.update(row.id).catch(() => {
                    // The failure map keeps the refusal and the row renders
                    // it; the rejection is the hook's batch contract, not
                    // an error this press has anywhere else to put.
                  });
                }}
              >
                {/* The POST blocks for the node's whole download-and-restart
                    window, up to five minutes, and the tracker keeps this
                    spinner on after the POST answers, so a bare disabled
                    button reads as nothing happening. */}
                {updating && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 motion-safe:animate-spin" />}
                {updating ? "Updating…" : "Update"}
              </Button>
            </div>
            {!row.canUpdate.ok && row.canUpdate.reason !== null && (
              <p className="col-span-full truncate text-detail text-muted-foreground">{row.canUpdate.reason}</p>
            )}
            {tracked !== null && (
              <p
                className={`col-span-full text-detail ${
                  tracked.phase === "done" || tracked.phase === "working" || tracked.phase === "restarting"
                    ? "text-success"
                    : tracked.phase === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                {updateLine(row, tracked)}
              </p>
            )}
            {/* This tab's refusal renders as its alert ONLY while the tracker
                has not also recorded the failure: once the entry exists, the
                sentence above carries the same words, and 2026-09-17's lesson
                says one failing row shows a refusal exactly once. */}
            {failure !== undefined && tracked?.phase !== "failed" && (
              <p role="alert" className="col-span-full text-destructive text-detail">
                {failure}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
```

- [ ] **Step 5: Switch the node page card to the new fields**

In `apps/server/web/src/components/nodes/node-update-card.tsx`:

Change line 29 from

```ts
const updating = nodeUpdate.pendingNodeId === node.id;
```

to

```ts
const updating = nodeUpdate.pendingNodeIds.has(node.id);
```

add beside it:

```ts
const failure = nodeUpdate.failures[node.id];
```

and replace the alert block (currently lines 95-99) with:

```tsx
{failure !== undefined && (
  <p role="alert" className="text-destructive text-detail">
    {failure}
  </p>
)}
```

Its doc comment about `nodeUpdate.reset()` on `node.id` change stays true (reset clears the failure map).

- [ ] **Step 6: Run all touched suites to verify green**

Run:

```bash
bun test apps/server/web/src/components/__tests__/updates-node-rows.test.tsx apps/server/web/src/components/nodes/__tests__/node-update-card.test.tsx apps/server/web/src/components/__tests__/updates-table.test.tsx
```

Expected: PASS with the file count at 3 (bun silently skips typo'd paths). The card's own tests drive the button through fetch mocks; they must pass unchanged, which is the proof the hook refactor is behavior-preserving for single presses.

- [ ] **Step 7: Verify and commit**

```bash
bunx turbo verify-types --filter=@internal/server-web
bunx biome check apps/server/web/src/hooks/use-node-update.ts apps/server/web/src/components/updates/node-rows.tsx apps/server/web/src/components/nodes/node-update-card.tsx apps/server/web/src/components/__tests__/updates-node-rows.test.tsx
git add apps/server/web/src/hooks/use-node-update.ts apps/server/web/src/components/updates/node-rows.tsx apps/server/web/src/components/nodes/node-update-card.tsx apps/server/web/src/components/__tests__/updates-node-rows.test.tsx
git commit -m "feat(web): fire Update all in parallel, rows spin from the tracker, Nodes section links its release notes"
```

---

### Task 5: Boundary verification and review loop

**Files:** none new; fixes only, if verification finds any.

- [ ] **Step 1: Full verification, per `.claude/rules/verification.md`**

```bash
bun run verify-types
bun run lint:check
bun run lint:prose
bun run test
```

Expected: all green. No `packages/` files changed, so no `turbo build` is needed (rule: only when a package under `packages/` or backend routes change). If any failure, fix it on this branch, re-run the failed command, and commit as `fix(web): ...`.

- [ ] **Step 2: Code review until clean**

Dispatch the `code-reviewer` agent over the branch diff (`git diff main...HEAD`); address every MAJOR and MINOR finding, then re-review until a full pass returns zero (per `.claude/rules/code-review.md`). A bug fix found in review gets a test with its fix.

- [ ] **Step 3: Spec conformance check**

Re-read `docs/superpowers/specs/2026-09-30-components-card-notes-parallel-refresh-design.md` and confirm each ruling has a landed implementation and test: Notes on Server row and Nodes header (browser rows only, dash inside apps untouched); parallel batch with per-row failure lines; job poll gate; tracker-owned row busy. The spec's "Not done" items (no storage persistence, no route changes) must show no diff.
