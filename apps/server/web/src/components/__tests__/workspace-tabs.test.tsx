import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { WorkspaceTab, WorkspaceTabs } from "@/components/workspace-tabs";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { armPaneFocusOnArrive, requestWorkspacePaneFocus, resetWorkspaceFocusForTests } from "@/lib/workspace-focus";
import { requestWorkspacePreview } from "@/lib/workspace-preview";
import { setFetchRouter } from "@/test-setup";
import type { WorkspaceDetail, WorkspacePaneRow } from "@/types/workspace";

/** A pane row as the workspace detail join delivers it; waiting state off by default. */
function pane(overrides: Partial<WorkspacePaneRow> = {}): WorkspacePaneRow {
  return {
    id: "pane-1",
    subshellId: "s-1",
    subshellName: "Alpha",
    subshellStatus: "running",
    subshellAlive: true,
    subshellExitCode: null,
    subshellWaitingSince: null,
    workingDir: "/tmp",
    ...overrides,
  };
}

/**
 * Renders one tab with a waiting flag precomputed (the parent owns
 * `isPaneWaiting`). The tab's dot reads the shared list cache
 * (`useSubshellRow`), so the harness provides a QueryClient seeded with one
 * quiet row per pane — unless `rows` overrides it, and `[]` is the world
 * where the list has not answered and the tab must draw no dot.
 */
function renderTab(opts: { waiting: boolean; removed?: string[]; selected?: string[]; rows?: unknown[] }) {
  const removed = opts.removed ?? [];
  const selected = opts.selected ?? [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(
    SUBSHELLS_QUERY_KEY,
    opts.rows ?? [{ id: "s-1", name: "Alpha", status: "running", alive: true, activity: "idle" }],
  );
  render(
    <QueryClientProvider client={client}>
      <WorkspaceTab
        pane={pane()}
        active
        waiting={opts.waiting}
        onSelect={() => selected.push("pane-1")}
        onRemove={() => removed.push("pane-1")}
      />
    </QueryClientProvider>,
  );
  return { removed, selected };
}

afterEach(cleanup);

describe("WorkspaceTab (narrow tab strip)", () => {
  it("renders the subshell name", () => {
    renderTab({ waiting: false });
    expect(screen.getByText("Alpha")).toBeDefined();
  });

  it("carries the rail's dot with the raw status/alive pair for a cached row", () => {
    renderTab({ waiting: false });
    const dot = document.querySelector("[data-status]");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("data-status")).toBe("running");
    expect(dot?.getAttribute("data-alive")).toBe("true");
  });

  it("draws NO dot before the list cache answers", () => {
    renderTab({ waiting: false, rows: [] });
    expect(document.querySelector("[data-status]")).toBeNull();
  });

  it("shows the compact waiting marker when the pane is waiting", () => {
    renderTab({ waiting: true });
    expect(screen.getByRole("img", { name: "waiting for you" })).toBeDefined();
  });

  it("shows no marker when the pane is not waiting", () => {
    renderTab({ waiting: false });
    expect(screen.queryByRole("img", { name: "waiting for you" })).toBeNull();
  });

  it("the marker is inside the select button, not the remove button", () => {
    renderTab({ waiting: true });
    const marker = screen.getByRole("img", { name: "waiting for you" });
    const button = marker.closest("button");
    expect(button?.getAttribute("aria-current")).toBe("true");
  });

  it("selecting fires onSelect", () => {
    const { selected } = renderTab({ waiting: true });
    fireEvent.click(screen.getByText("Alpha"));
    expect(selected).toEqual(["pane-1"]);
  });

  it("the final tab's × is live: removal retires the workspace (ruling 2026-10-20)", () => {
    const { removed } = renderTab({ waiting: false });
    const button = screen.getByLabelText("Remove Alpha from workspace");
    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);
    expect(removed).toEqual(["pane-1"]);
  });

  it("the × fires onRemove", () => {
    const { removed } = renderTab({ waiting: false });
    fireEvent.click(screen.getByLabelText("Remove Alpha from workspace"));
    expect(removed).toEqual(["pane-1"]);
  });
});

/**
 * Regression (iPhone, operator report 2026-10-21): selecting a pane from the
 * rail switched the header and the terminal but left the strip scrolled to the
 * old tabs, because nothing in `WorkspaceTabs` ever scrolled the active tab
 * into view. The fix keys one scroll onto the selected pane's id, finding the
 * tab through its `data-pane-id`; this drives the REAL focus bus the rail
 * fires, so the selected-id change is the production path, not a stand-in.
 */
function stripPane(id: string, subshellId: string): WorkspacePaneRow {
  return pane({ id, subshellId, subshellName: subshellId });
}

const stripDetail: WorkspaceDetail = {
  workspace: {
    id: "w1",
    name: "Scroll",
    layout: null,
    subshellCount: 3,
    createdAt: "2026-10-21T10:00:00.000Z",
    updatedAt: "2026-10-21T10:00:00.000Z",
  },
  panes: [stripPane("p0", "s-1"), stripPane("p1", "s-2"), stripPane("p2", "s-3")],
};

/** Mounts the whole strip at `/workspaces/w1` (same router pattern as `workspace-tabs-strip-scroll.test.tsx`). */
function renderStrip(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces/$id",
    component: () => (
      <QueryClientProvider client={qc}>
        <WorkspaceTabs detail={stripDetail} intent={null} claimIntent={() => false} onRefetch={async () => undefined} />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute]),
    history: createMemoryHistory({ initialEntries: ["/workspaces/w1"] }),
  });
  render(<RouterProvider router={router} />);
}

/**
 * Regression (review 2026-10-30): the arrival focus must survive the gap
 * between arming and the pane row's arrival — a just-filed launch arms its
 * pane before the create's refetch lands — and a NEWER arm must replace a
 * held one, so a target whose row never arrives cannot strand every later
 * click in the same mount. The dock shares the rule; the strip is the half
 * unit-testable without a real dockview.
 */
describe("WorkspaceTabs: the arrival focus is held until it lands", () => {
  afterEach(() => {
    cleanup();
    setFetchRouter(null);
    resetWorkspaceFocusForTests();
  });

  /** Mounts the strip with mutable `detail`, honouring an external arm. */
  function renderLiveStrip(initialPanes: WorkspacePaneRow[]): {
    set: (panes: WorkspacePaneRow[]) => void;
  } {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let current = initialPanes;
    const holder = { set: (_: WorkspacePaneRow[]) => undefined as undefined };
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const workspaceRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workspaces/$id",
      component: () => {
        const [panes, setPanes] = useState(current);
        holder.set = (next: WorkspacePaneRow[]) => {
          current = next;
          setPanes(next);
        };
        return (
          <QueryClientProvider client={qc}>
            <WorkspaceTabs
              detail={{ ...stripDetail, panes }}
              intent={null}
              claimIntent={() => false}
              onRefetch={async () => undefined}
            />
          </QueryClientProvider>
        );
      },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([workspaceRoute]),
      history: createMemoryHistory({ initialEntries: ["/workspaces/w1"] }),
    });
    render(<RouterProvider router={router} />);
    return holder;
  }

  it("selects the armed tab once its row arrives, and a newer arm replaces a held one", async () => {
    setFetchRouter((input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/subshells") return Promise.resolve(new Response("[]"));
      return Promise.resolve(new Response("{}"));
    });
    const strip = renderLiveStrip([stripPane("p0", "s-1"), stripPane("p1", "s-2")]);
    await waitFor(() => {
      if (!document.querySelector("[data-terminal-controls-scroller]")) {
        throw new Error("the tab strip is not mounted yet");
      }
    });

    // Arm a pane whose row does not exist yet: nothing selects, the target is held.
    act(() => armPaneFocusOnArrive("s-3"));
    act(() => strip.set([stripPane("p0", "s-1"), stripPane("p1", "s-2")]));
    expect(document.querySelector('[data-pane-id="p0"]')?.querySelector("button")?.getAttribute("aria-current")).toBe(
      "true",
    );

    // A stale held target must not strand the newer arm: s-2 is what the
    // person clicked last, and its row is already here.
    act(() => armPaneFocusOnArrive("s-2"));
    act(() => strip.set([stripPane("p0", "s-1"), stripPane("p1", "s-2")]));
    expect(document.querySelector('[data-pane-id="p1"]')?.querySelector("button")?.getAttribute("aria-current")).toBe(
      "true",
    );

    // And the held-then-arriving case for real: arm s-3 while its row is
    // still absent (this set delivers only what was already here, so the
    // arm drains into a held target that cannot be honoured yet), then
    // bring the row and see the hold honoured.
    act(() => armPaneFocusOnArrive("s-3"));
    act(() => strip.set([stripPane("p0", "s-1"), stripPane("p1", "s-2")]));
    expect(document.querySelector('[data-pane-id="p1"]')?.querySelector("button")?.getAttribute("aria-current")).toBe(
      "true",
    );
    act(() => strip.set([stripPane("p0", "s-1"), stripPane("p1", "s-2"), stripPane("p2", "s-3")]));
    expect(document.querySelector('[data-pane-id="p2"]')?.querySelector("button")?.getAttribute("aria-current")).toBe(
      "true",
    );
  });
});

describe("WorkspaceTabs: the active tab scrolls into view", () => {
  afterEach(() => {
    cleanup();
    setFetchRouter(null);
    resetWorkspaceFocusForTests();
  });

  it("a rail focus request activates the tab and scrolls it into view once, at `nearest`", async () => {
    setFetchRouter((input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/subshells") return Promise.resolve(new Response("[]"));
      // Refused, so the panes' terminals never reach `new WebSocket` (the
      // sibling intent test's reason, verbatim).
      if (url.pathname === "/api/auth/ws-token" && (init?.method ?? "GET") === "POST")
        return Promise.resolve(new Response("{}", { status: 503 }));
      return Promise.resolve(new Response("{}"));
    });
    // happy-dom answers scrollIntoView with an unobservable no-op, so spy on
    // the prototype and restore it after the test.
    const original = Element.prototype.scrollIntoView;
    const calls: Array<{ el: Element; opts: ScrollIntoViewOptions | undefined }> = [];
    Element.prototype.scrollIntoView = function (this: Element, opts?: boolean | ScrollIntoViewOptions) {
      if (typeof opts === "object") calls.push({ el: this, opts });
    };
    try {
      renderStrip();
      // RouterProvider paints asynchronously, so wait for the strip first.
      await waitFor(() => {
        if (!document.querySelector("[data-terminal-controls-scroller]")) {
          throw new Error("the tab strip is not mounted yet");
        }
      });
      let handled = false;
      act(() => {
        handled = requestWorkspacePaneFocus("s-3", "w1");
      });
      expect(handled).toBe(true);

      // The strip re-rendered with s-3's tab active…
      const activeTab = document.querySelector('[data-pane-id="p2"]');
      expect(activeTab).not.toBeNull();
      expect(activeTab?.querySelector("button")?.getAttribute("aria-current")).toBe("true");
      // …and exactly one scroll landed on THAT tab (the mount also scrolls the
      // initial tab; filtering by element ignores that one).
      const moved = calls.filter((c) => c.el === activeTab);
      expect(moved.length).toBe(1);
      expect(moved[0].opts).toEqual({ inline: "nearest", block: "nearest" });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

it("opens one phone preview tab and closes it without removing the subshell", async () => {
  const deletes: string[] = [];
  setFetchRouter((input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "DELETE") deletes.push(url.pathname);
    if (url.pathname === "/api/subshells") return Promise.resolve(new Response("[]"));
    if (url.pathname === "/api/auth/ws-token") return Promise.resolve(new Response("{}", { status: 503 }));
    return Promise.resolve(new Response("{}"));
  });
  try {
    renderStrip();
    await waitFor(() => expect(Boolean(document.querySelector("[data-terminal-controls-scroller]"))).toBe(true));
    act(() => {
      expect(requestWorkspacePreview("s-1", { kind: "screen" })).toBe(true);
    });
    await screen.findByRole("button", { name: "Virtual display · s-1" });
    act(() => {
      requestWorkspacePreview("s-1", { kind: "screen" });
    });
    expect(screen.getAllByRole("button", { name: "Virtual display · s-1" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close Virtual display for s-1" }));
    expect(screen.queryByRole("button", { name: "Virtual display · s-1" }) === null).toBe(true);
    expect(document.querySelector('[data-pane-id="p0"]')).toBeTruthy();
    act(() => {
      requestWorkspacePreview("s-1", { kind: "app", port: 41430 });
    });
    await screen.findByRole("button", { name: "App · 41430 · s-1" });
    act(() => {
      requestWorkspacePreview("s-1", { kind: "screen" });
    });
    await screen.findByRole("button", { name: "Virtual display · s-1" });
    expect(screen.getByRole("button", { name: "App · 41430 · s-1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Virtual display for s-1" }));
    expect(screen.getByRole("button", { name: "App · 41430 · s-1" })).toBeTruthy();
    expect(deletes).toEqual([]);
  } finally {
    cleanup();
    setFetchRouter(null);
  }
});
