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
import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import { onWorkspacePaneFocusRequest } from "@/lib/workspace-focus";
import type { SubshellView } from "@/types/subshell";

/**
 * The rail row carries four consumers on ONE element: nav, drag, the
 * right-click menu, and — since 2026-09-24 — the tooltip. The tooltip moved
 * off the native `title` because the browser paints native tooltips at the
 * SYSTEM font size, so ctrl +/- scaled the rail and left the reveal behind;
 * an in-page popup scales with the page. What is pinned here is the merge
 * itself — the tooltip's trigger attributes land ON the Link rather than on
 * a wrapper (the thing the old native choice dodged, and the reason the
 * gesture trio survives), and no `title` is left to double-draw. Hover is
 * not reproducible under happy-dom (floating-ui's hover hook needs the
 * pointer event stack a real browser provides), but the tooltip's FOCUS path
 * opens the same popup and is — so the detail string and the size step are
 * asserted as rendered here, and the whole path was verified by mouse, at
 * 100% and 200% zoom, in a real browser against the e2e stack (2026-09-24).
 */
function makeSubshell(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    presetId: "p1",
    harnessId: "claude",
    nodeId: "mac",
    nodeOffline: false,
    name: "auth-refactor",
    nameLocked: false,
    workingDir: "/home/theo/projects/auth",
    status: "running",
    createdAt: "2026-09-01T00:00:00.000Z",
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
    unseenPush: false,
    access: "owner",
    ssh: false,
    ...overrides,
  };
}

function mockFetch(withSubagents = false, canSelect = false) {
  const original = globalThis.fetch;
  const selectPosts: unknown[] = [];
  // How many batch reads the row actually issued — a parked row must
  // watch nothing, and only the DOM assertions would not catch a fetch that
  // happens and draws nothing.
  let subagentReads = 0;
  // The snapshot answers with whatever the LAST select chose: the row's
  // parent-click reset branch only fires while a selection is confirmed, so a
  // constant null would hide it (and a queued command only becomes the
  // confirmed view on the next read, exactly like the real service).
  let selectedId: string | null = null;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (withSubagents && path === "/api/subshells/subagents") {
      subagentReads += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            s1: {
              agents: [{ id: "child", name: "Review changes", status: "running" }],
              selectedId,
              canSelect,
            },
          }),
        ),
      );
    }
    if (withSubagents && canSelect && path === "/api/subshells/s1/subagents/select" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { agentId: string | null };
      selectedId = body.agentId;
      selectPosts.push(body);
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }
    if (path === "/api/presets") return Promise.resolve(new Response(JSON.stringify([])));
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), selectPosts, subagentReads: () => subagentReads };
}

function renderRow(subshell: SubshellView, focused = false, onOpen?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <SubshellRecentRow
        subshell={subshell}
        focused={focused}
        onOpen={onOpen}
        nodeLabel="mac mini"
        agentLabel="Claude Code"
      />
    ),
  });
  const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/subshells/$id" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  // mockFetch restores in each test's finally; nothing else to undo.
});

describe("SubshellRecentRow tooltip (2026-09-24: in-page, so it zooms)", () => {
  it("opens actions from a visible button without navigating", async () => {
    const { restore } = mockFetch();
    try {
      renderRow(makeSubshell());
      const actions = await screen.findByRole("button", { name: "Actions for auth-refactor" });
      expect(actions.closest("a")).toBeNull();
      fireEvent.click(actions);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: /Edit title/ })).toBeDefined());
      expect(screen.getByRole("link", { name: /auth-refactor/ })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("merges the tooltip trigger onto the Link itself, not a wrapper", async () => {
    const { restore } = mockFetch();
    try {
      renderRow(makeSubshell());
      const link = await screen.findByRole("link", { name: /auth-refactor/ });
      // Base UI stamps its trigger identifier on the trigger element — the
      // Link, via `render`. A wrapper element instead would be the shape
      // that used to break one of the row's other gestures.
      expect(link.hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
      fireEvent.focus(link);
      // Anchor on the bolded label, then walk up to the popup: labels and
      // values are separate spans now (TooltipLabelledLines), so no single
      // element carries a whole line any more.
      const nameLabel = await screen.findByText("Name:");
      const popup = nameLabel.closest("[class*='bg-popover']");
      expect(popup).not.toBeNull();
      expect(popup?.textContent).toContain("Name: auth-refactor");
      expect(popup?.textContent).toContain("Node: mac mini");
      expect(popup?.textContent).toContain("Directory: /home/theo/projects/auth");
      // One step up the scale (operator call): body, not detail.
      expect(popup?.closest("[class*='text-body']")).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("leaves the row a Link: href, draggable, and no native title", async () => {
    const { restore } = mockFetch();
    try {
      renderRow(makeSubshell());
      const link = await screen.findByRole("link", { name: /auth-refactor/ });
      expect(link.getAttribute("href")).toBe("/subshells/s1");
      expect(link.getAttribute("draggable")).toBe("true");
      // The native reveal is GONE — leaving both would double-draw a tooltip.
      expect(link.getAttribute("title")).toBeNull();
      await waitFor(() => expect(screen.getByRole("link")).toBeTruthy());
    } finally {
      restore();
    }
  });
});

it("selects a child through the parent endpoint and returns to the parent on the row click", async () => {
  // canSelect is the SERVER's answer (supported harness, actor may navigate);
  // the row renders the child as an action only when it says so. The parent
  // click must reset the shared view back to the main agent.
  const { restore, selectPosts } = mockFetch(true, true);
  // Stand in for the mounted dock: the child's select answers TRUE here, so
  // the click focuses the pane on screen instead of navigating away from the
  // rail this row lives in (the same success path the real dock takes).
  const stopFocus = onWorkspacePaneFocusRequest((id) => id === "s1");
  try {
    let opened = 0;
    renderRow(makeSubshell(), false, () => {
      opened++;
    });
    fireEvent.click(await screen.findByRole("button", { name: "Expand subshell details" }));
    const child = await screen.findByRole("button", { name: /Review changes/ });
    fireEvent.click(child);
    await waitFor(() => expect(selectPosts).toEqual([{ agentId: "child" }]));
    // The reset only arms once the SELECTED child comes back confirmed from
    // the server (a queued command is not a view change), so wait for the
    // re-render that carries it before clicking the parent.
    await waitFor(() => expect(child.className).toContain("bg-accent"));
    fireEvent.click(screen.getByRole("link", { name: /auth-refactor/ }));
    await waitFor(() => expect(selectPosts).toEqual([{ agentId: "child" }, { agentId: null }]));
    expect(opened).toBe(1);
  } finally {
    stopFocus();
    restore();
  }
});

for (const focused of [true, false]) {
  it(`toggles child rows from the arrow without opening the ${focused ? "active" : "inactive"} parent`, async () => {
    const { restore } = mockFetch(true);
    let opened = 0;
    try {
      renderRow(makeSubshell(), focused, () => {
        opened++;
      });
      const arrow = await screen.findByRole("button", {
        name: focused ? "Collapse subshell details" : "Expand subshell details",
      });
      expect(arrow.getAttribute("aria-expanded")).toBe(String(focused));
      if (!focused) fireEvent.click(arrow);
      expect(arrow.closest("a")).toBeNull();
      expect(screen.queryByText(/^Subagents/)).toBeNull();
      fireEvent.click(arrow);
      expect(arrow.getAttribute("aria-expanded")).toBe("false");
      expect(document.getElementById(arrow.getAttribute("aria-controls") ?? "")?.hidden).toBe(true);
      expect(opened).toBe(0);
      fireEvent.click(screen.getByRole("link", { name: /auth-refactor/ }));
      expect(opened).toBe(focused ? 0 : 1);
      expect(arrow.getAttribute("aria-expanded")).toBe(focused ? "true" : "false");
    } finally {
      restore();
    }
  });
}

it("a parked row (running at alive:0) draws no child roster and issues no batch read", async () => {
  // RUNNING is the row's TWO facts. The snapshot below carries a live child,
  // so an `enabled` gate that trusted only `status === "running"` would draw
  // the roster AND start the batch watch on a pane that has no child to show
  // (the parked running/alive:0 shape an MCP-created window parks at).
  const { restore, subagentReads } = mockFetch(true);
  try {
    renderRow(makeSubshell({ alive: false }));
    await screen.findByRole("link", { name: /auth-refactor/ });
    // `hidden: true` on purpose: the children container stays mounted and
    // merely hidden, so a default query would pass vacuously even if the
    // roster rendered into it.
    expect(screen.queryByRole("button", { name: /subagents/i, hidden: true })).toBeNull();
    expect(screen.queryByText("Review changes")).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(subagentReads()).toBe(0);
  } finally {
    restore();
  }
});

it("keeps cross-agent leaf rows clickable but prevents dragging", async () => {
  const { restore } = mockFetch();
  let opened = 0;
  try {
    renderRow(makeSubshell({ crossAgent: true, parentSubshellId: "parent" }), false, () => {
      opened += 1;
    });
    const link = await screen.findByRole("link", { name: /auth-refactor/ });
    expect(link.getAttribute("draggable")).toBe("false");
    let writes = 0;
    const accepted = fireEvent.dragStart(link, {
      dataTransfer: {
        setData: () => {
          writes += 1;
        },
      },
    });
    expect(accepted).toBe(false);
    expect(writes).toBe(0);
    fireEvent.click(link);
    expect(opened).toBe(1);
  } finally {
    restore();
  }
});
