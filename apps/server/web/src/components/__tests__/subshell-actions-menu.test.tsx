import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import type { SubshellView } from "@/types/subshell";

/** A full SubshellView with overridable fields — mirrors the subshell-list fixture. */
function makeSubshell(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "id-1",
    presetId: null,
    harnessId: "claude",
    nodeOffline: false,
    name: "subshell",
    nameLocked: false,
    workingDir: "/tmp/project",
    status: "running",
    createdAt: "2026-08-30T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: false,
    waitingSince: null,
    access: "owner",
    ...overrides,
  };
}

/**
 * The menu needs a router (its preset-edit item calls `useNavigate`), so it
 * renders as an index route of a minimal memory router — the same context
 * the app itself installs.
 */
async function renderMenu(
  subshell: SubshellView,
  children?: ReactNode,
  diagnostics?: { on: boolean; onToggle: () => void },
) {
  // retry: 0 so the presets query settles on the first canned response.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    // With children the menu switches to right-click mode around the row
    // (sidebar use, spec 2026-09-03); without, today's ⋯ button.
    component: () => (
      <SubshellActionsMenu subshell={subshell} diagnostics={diagnostics}>
        {children}
      </SubshellActionsMenu>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** One preset row; only the fields the menu's lookup reads. */
function presetRow(p: { id: string; name: string }) {
  return {
    id: p.id,
    harnessId: "claude",
    name: p.name,
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
    restartOnExit: 0,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

/** Records every request's method/url/body; answers the presets query with
 *  `presets` (default: none) and mutations with `{ ok: true }`. */
function mockFetch(presets: unknown[] = []) {
  const calls: { method: string; url: string; body: string | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ method: init?.method ?? "GET", url: url.pathname, body: init?.body as string | undefined });
    return Promise.resolve(
      new Response(JSON.stringify(url.pathname.startsWith("/api/presets") ? presets : { ok: true })),
    );
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Opens the menu the keyboard way (Base UI triggers open on pointerdown,
 *  which happy-dom cannot emulate; ArrowDown is equivalent) and waits for
 *  the items to paint. */
async function openMenu(subshellName: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${subshellName}` }), { key: "ArrowDown" });
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));
}

describe("SubshellActionsMenu — notification bell", () => {
  afterEach(cleanup);

  it("offers 'Notify when done' on a muted subshell and PATCHes notify:true", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderMenu(makeSubshell({ id: "abc", notify: false }));
      await openMenu("subshell");
      fireEvent.click(screen.getByRole("menuitem", { name: "Notify when done" }));
      await waitFor(() =>
        expect(calls).toContainEqual({ method: "PATCH", url: "/api/subshells/abc/notify", body: '{"notify":true}' }),
      );
      expect(screen.queryByRole("menuitem", { name: "Mute notifications" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("offers 'Mute notifications' on a notified subshell and PATCHes notify:false", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderMenu(makeSubshell({ id: "abc", notify: true }));
      await openMenu("subshell");
      fireEvent.click(screen.getByRole("menuitem", { name: "Mute notifications" }));
      await waitFor(() =>
        expect(calls).toContainEqual({ method: "PATCH", url: "/api/subshells/abc/notify", body: '{"notify":false}' }),
      );
    } finally {
      restore();
    }
  });
});

describe("SubshellActionsMenu — access gating (spec §4.1)", () => {
  afterEach(cleanup);

  it("renders no actions menu at all for a view grantee", async () => {
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSubshell({ access: "view" }));
      expect(screen.queryByRole("button", { name: "Actions for subshell" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("an edit grantee can manage the subshell but not the bell, sharing, or closing", async () => {
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSubshell({ access: "edit", alive: true }));
      await openMenu("subshell");
      expect(screen.getByRole("menuitem", { name: "Edit title" })).toBeDefined();
      expect(screen.queryByRole("menuitem", { name: "Add note" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Notify when done" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Share…" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Close" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("the removed actions stay gone: no Terminate, no title pin, no Terminal history (spec 2026-09-03)", async () => {
    const { restore } = mockFetch();
    try {
      // A dead row is the one state that still carries a lifecycle item, so
      // its absence there proves the removal, not just the alive-gate.
      for (const alive of [true, false]) {
        await renderMenu(makeSubshell({ alive }));
        await openMenu("subshell");
        expect(screen.queryByRole("menuitem", { name: "Terminate" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "Pin this title" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "Resume auto title" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "Terminal history…" })).toBeNull();
        cleanup();
      }
    } finally {
      restore();
    }
  });

  it("Clone… is owner-only (an edit grantee's clone would 404 on the preset) and opens the clone dialog", async () => {
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSubshell({ access: "edit" }));
      await openMenu("subshell");
      expect(screen.queryByRole("menuitem", { name: "Clone…" })).toBeNull();
      cleanup();

      await renderMenu(makeSubshell({ access: "owner" }));
      await openMenu("subshell");
      fireEvent.click(screen.getByRole("menuitem", { name: "Clone…" }));
      expect(await screen.findByLabelText("Clone name")).toBeDefined();
      expect(screen.getByRole("button", { name: "Launch clone" })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("Edit title opens the rename dialog and a save PATCHes the trimmed name", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderMenu(makeSubshell({ id: "abc" }));
      await openMenu("subshell");
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit title" }));
      const input = await screen.findByRole("textbox", { name: "New subshell title" });
      fireEvent.change(input, { target: { value: " Renamed " } });
      fireEvent.click(screen.getByRole("button", { name: "Save title" }));
      await waitFor(() =>
        expect(calls).toContainEqual({
          method: "PATCH",
          url: "/api/subshells/abc/name",
          body: JSON.stringify({ name: "Renamed" }),
        }),
      );
    } finally {
      restore();
    }
  });
});

describe("SubshellActionsMenu — Edit preset (dead-row recovery loop)", () => {
  afterEach(cleanup);

  const FAST = [presetRow({ id: "p1", name: "Fast" })];

  it("a dead subshell that launched from a preset offers the named Edit preset item", async () => {
    const { restore } = mockFetch(FAST);
    try {
      await renderMenu(makeSubshell({ alive: false, presetId: "p1" }));
      await openMenu("subshell");
      fireEvent.click(screen.getByRole("menuitem", { name: 'Edit preset "Fast"' }));
    } finally {
      restore();
    }
  });

  it("absent while the subshell lives, and for a presetless launch either way", async () => {
    const { restore } = mockFetch(FAST);
    try {
      await renderMenu(makeSubshell({ alive: true, presetId: "p1" }));
      await openMenu("subshell");
      expect(screen.queryByRole("menuitem", { name: /Edit preset/ })).toBeNull();
      cleanup();

      await renderMenu(makeSubshell({ alive: false, presetId: null }));
      await openMenu("subshell");
      expect(screen.queryByRole("menuitem", { name: /Edit preset/ })).toBeNull();
    } finally {
      restore();
    }
  });

  it("stays hidden until the preset row resolves — a bare id would only confuse", async () => {
    const { restore } = mockFetch([]); // the row is gone (deleted, or a foreign user's)
    try {
      await renderMenu(makeSubshell({ alive: false, presetId: "p1" }));
      await openMenu("subshell");
      expect(screen.queryByRole("menuitem", { name: /Edit preset/ })).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("SubshellActionsMenu — diagnostics toggle (spec 2026-09-21 Wave C)", () => {
  afterEach(cleanup);

  it("the page's toggle renders as a checkable item, on and off, and clicking flips it", async () => {
    let toggles = 0;
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSubshell(), undefined, { on: true, onToggle: () => toggles++ });
      await openMenu("subshell");
      const item = screen.getByRole("menuitem", { name: "Diagnostics" });
      expect(item.querySelector(".text-primary")).toBeDefined();
      fireEvent.click(item);
      expect(toggles).toBe(1);
      cleanup();

      await renderMenu(makeSubshell(), undefined, { on: false, onToggle: () => toggles++ });
      await openMenu("subshell");
      // Unchecked keeps its slot (invisible), so the rows align either way.
      expect(screen.getByRole("menuitem", { name: "Diagnostics" }).querySelector(".text-transparent")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("absent without the prop — the shared surfaces (cards, rows) offer no diagnostics switch", async () => {
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSubshell());
      await openMenu("subshell");
      expect(screen.queryByRole("menuitem", { name: "Diagnostics" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("the sidebar right-click set does not gain it (a rail row has no terminal under it)", async () => {
    const { restore } = mockFetch();
    const row = <a href="/subshells/id-1">the row</a>;
    try {
      await renderMenu(makeSubshell(), row, { on: true, onToggle: () => {} });
      fireEvent.contextMenu(screen.getByText("the row"));
      await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(6));
      expect(screen.queryByRole("menuitem", { name: "Diagnostics" })).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("SubshellActionsMenu — children mode, sidebar right-click (spec 2026-09-03)", () => {
  afterEach(cleanup);

  const row = <a href="/subshells/id-1">the row</a>;

  it("wraps the row with NO ⋯ button; right-click offers the same actions", async () => {
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSubshell(), row);
      expect(screen.getByText("the row")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Actions for subshell" })).toBeNull();
      fireEvent.contextMenu(screen.getByText("the row"));
      await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(6));
      // The curated sidebar set after spec 2026-09-03: close, bell, clone,
      // share, edit-title — plus the QR (2026-09-19), which is sidebar-flagged
      // because "open this one elsewhere" is most often wanted from the rail.
      // Terminate is gone (Close subsumes it; the alive row has no lifecycle
      // item at all) — still NOT the dialog-less extras.
      expect(screen.getByRole("menuitem", { name: "Edit title" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "QR code…" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Notify when done" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Clone…" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Share…" })).toBeDefined();
      expect(screen.getByRole("menuitem", { name: "Close" })).toBeDefined();
      expect(screen.queryByRole("menuitem", { name: "Add note" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Terminate" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Pin this title" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Terminal history…" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("a view grantee gets the bare row back — nothing to open", async () => {
    const { restore } = mockFetch();
    try {
      await renderMenu(makeSubshell({ access: "view" }), row);
      expect(screen.getByText("the row")).toBeDefined();
      fireEvent.contextMenu(screen.getByText("the row"));
      expect(screen.queryAllByRole("menuitem").length).toBe(0);
    } finally {
      restore();
    }
  });
});
