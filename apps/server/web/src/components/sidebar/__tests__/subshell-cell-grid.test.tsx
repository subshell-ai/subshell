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
import { flatCellRows, paneInitial, SubshellCell, SubshellCellGrid } from "@/components/sidebar/subshell-cell-grid";
import type { SubshellNodeGroup } from "@/lib/subshell-node-groups";
import { groupSubshellsByNode } from "@/lib/subshell-node-groups";
import { onWorkspacePaneFocusRequest, takePaneFocusOnArrive } from "@/lib/workspace-focus";
import { setFetchRouter } from "@/test-setup";
import type { SubshellView } from "@/types/subshell";

/**
 * The rail's cell view: the dot's state language at grid size. What is pinned
 * here is that a cell is the SAME one language (the dot's fills and bell, not
 * a second encoding), that it keeps the row's full gesture set (nav, drag,
 * tooltip, right-click menu) on one element, and that the two pure helpers
 * behind it stay honest — the pane-initial glyph (hint not key), and a flat
 * grid whose cell SET can never drift from what grouped mode renders while
 * its cells cluster by machine onto one plate.
 */

function sub(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    presetId: null,
    harnessId: "claude-code",
    nodeId: "local",
    nodeOffline: false,
    name: "auth-refactor",
    nameLocked: false,
    workingDir: "/home/theo/projects/auth",
    status: "running",
    createdAt: "2026-09-25T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: true,
    waitingSince: null,
    unseenPush: false,
    access: "owner",
    ...overrides,
  } as SubshellView;
}

function mockFetch(posted: string[] = [], homes: "one" | "none" = "one"): () => void {
  listGetAnswered = false;
  setFetchRouter(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = String(req.url);
    let body: unknown = {};
    if (url.includes("/api/presets")) body = [];
    else if (url.includes("/api/plugins")) body = { plugins: [] };
    else if (url.includes("/api/workspaces")) {
      if (req.method === "POST") {
        posted.push(url);
        body = { id: "w-new" };
      } else {
        listGetAnswered = true;
        // `else` is filed in w2; `here` and `newguy` are not filed anywhere.
        body =
          homes === "none"
            ? []
            : [
                {
                  id: "w2",
                  name: "Holder",
                  layout: null,
                  subshellCount: 1,
                  createdAt: "",
                  updatedAt: "2026-10-10T00:00:00.000Z",
                  panes: [{ id: "p", subshellId: "else" }],
                },
              ];
      }
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return () => setFetchRouter(null);
}

/**
 * True once the workspaces LIST the open-as-tab hook reads has landed. The
 * fetch router flags the moment it answers that GET — the settle a test could
 * otherwise only guess at with ticks.
 */
async function listLoaded(): Promise<boolean> {
  return listGetAnswered;
}
let listGetAnswered = false;

function renderCell(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => ui });
  const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/subshells/$id" });
  const wsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/workspaces/$id" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute, wsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  return Object.assign(
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    { router },
  );
}

afterEach(() => {
  cleanup();
});

describe("paneInitial (the flat grid's glyph)", () => {
  it("is the name's first letter, uppercased", () => {
    expect(paneInitial("auth-refactor")).toBe("A");
    expect(paneInitial("beta")).toBe("B");
  });

  it("answers the empty string for an empty name rather than crashing", () => {
    expect(paneInitial("")).toBe("");
  });
});

describe("flatCellRows (one grid, same set as grouped mode)", () => {
  const rows = [
    sub({ id: "w", nodeId: "n1", activity: "idle", waitingSince: "2026-09-25T00:00:00.000Z" }),
    sub({ id: "a", nodeId: "n1", activity: "active" }),
    sub({ id: "i", nodeId: "n2", activity: "idle" }),
    sub({ id: "t", nodeId: "n2", status: "terminated", alive: false, activity: "terminated" }),
    sub({ id: "c", nodeId: "n1", crossAgent: true, activity: "idle" }),
  ];
  const nodes = [
    { id: "n1", name: "mac-mini" },
    { id: "n2", name: "mbp" },
  ] as never;

  const groups = groupSubshellsByNode(
    rows.filter((r) => r.crossAgent !== true),
    nodes,
    { limit: 8 },
  );
  const comms = rows.filter((r) => r.crossAgent === true);
  // The spotlight carries `w`, which is ALSO inside its group's cap — the
  // dedup below is being tested on a row that appears twice, the common case.
  const w = rows.find((r) => r.id === "w");
  if (!w) throw new Error("fixture broken");
  const spotlight = [w];

  it("bands the grid: notifications, then machine clusters, then comms — a spotlight row shows in its band AND its cluster", () => {
    // Four bands (operator order 2026-09-26): notifications lead, then the
    // machines, then cross-agent comms last. The spotlight is a SIBLING, not an
    // extraction (operator ruling: bands appear AND keep their cluster), so `w`
    // shows TWICE — once in the top band, once inside its n1 run — while the
    // comms pane `c`, partitioned out of every group, shows once in the bottom
    // band. n1 (a waiting row, rank 0) leads the machine band over n2.
    const flat = flatCellRows(groups, comms, spotlight, new Set());
    expect(flat.map((r) => r.id)).toEqual(["w", "w", "a", "i", "t", "c"]);
    const ids = flat.map((r) => r.id);
    expect(ids.filter((x) => x === "w")).toHaveLength(2);
    expect(ids.filter((x) => x === "c")).toHaveLength(1);
  });

  it("orders machine clusters by liveliest member and cells by band within a cluster", () => {
    // No selection, no spotlight: clusters rank like the grouped mode's groups
    // (the MINIMUM status rank across members), n1 ahead of n2, and each
    // cluster's internals follow the shared band order.
    const flat = flatCellRows(groups, comms, [], new Set());
    expect(flat.map((r) => r.id)).toEqual(["w", "a", "i", "t", "c"]);
  });

  it("promotes a cluster holding a selected pane above more-urgent clusters", () => {
    // The selection outranks urgency ACROSS clusters (operator ask 2026-09-27):
    // n2 (idle/terminated, less urgent) leads when its `i` is a workspace pane,
    // even though n1 has the waiting row. Urgency still orders WITHIN each band.
    const flat = flatCellRows(groups, comms, [], new Set(["i"]));
    expect(flat.map((r) => r.id)).toEqual(["i", "t", "w", "a", "c"]);
  });

  it("carries a group's cap through: a row beyond the cap is absent from flat UNLESS the spotlight lists it", () => {
    // The parity rule: grouped mode shows a capped-out row ONLY in the
    // (uncapped) spotlight; flat must show it exactly then, never more, never
    // less. Now it surfaces in the notifications band.
    const many = Array.from({ length: 10 }, (_, i) => sub({ id: `m${i}`, nodeId: "n1", activity: "idle" }));
    const capped = groupSubshellsByNode(many, nodes, { limit: 8 });
    const withoutSpotlight = flatCellRows(capped, [], [], new Set());
    expect(withoutSpotlight).toHaveLength(8);
    expect(withoutSpotlight.map((r) => r.id)).toEqual(many.slice(0, 8).map((r) => r.id));

    const m9 = many.find((r) => r.id === "m9");
    if (!m9) throw new Error("fixture broken");
    const withSpotlight = flatCellRows(capped, [], [m9], new Set());
    expect(withSpotlight.map((r) => r.id)).toContain("m9");
    expect(withSpotlight).toHaveLength(9);
  });

  it("returns an empty grid for no groups", () => {
    expect(flatCellRows([] as SubshellNodeGroup[], [], [], new Set())).toEqual([]);
  });
});

describe("SubshellCell", () => {
  it("is a Link to the subshell, with the status word in its accessible name", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <SubshellCell subshell={sub()} focused={false} labels={{ nodeLabel: "mac-mini", agentLabel: "Claude Code" }} />,
      );
      const link = await screen.findByRole("link");
      expect(link.getAttribute("href")).toBe("/subshells/s1");
      expect(link.getAttribute("aria-label")).toBe("auth-refactor: idle");
      expect(link.getAttribute("draggable")).toBe("true");
    } finally {
      restore();
    }
  });

  // The mark is ONE crisp line: a terminated cell's frame (its whole state
  // fill) must yield to the ring, or the focused and unfocused cells are two
  // faint frames apart.

  it("a plain left-click means the tab: focus here, else go to its workspace (spec 2026-10-17)", async () => {
    const restore = mockFetch();
    const requests: string[] = [];
    // A dock is up and answers only for "here" (it holds that pane on screen).
    const unsub = onWorkspacePaneFocusRequest((id) => {
      requests.push(id);
      return id === "here";
    });
    try {
      const { router } = renderCell(
        <>
          <SubshellCell
            subshell={sub({ id: "here", name: "member" })}
            focused={false}
            labels={{ nodeLabel: "m", agentLabel: "A" }}
          />
          <SubshellCell
            subshell={sub({ id: "else", name: "plain" })}
            focused={false}
            labels={{ nodeLabel: "m", agentLabel: "A" }}
          />
        </>,
      );
      const linkFor = async (id: string) =>
        (await screen.findAllByRole("link")).find((l) => l.getAttribute("href") === `/subshells/${id}`) as HTMLElement;
      const here = await linkFor("here");
      // Open on screen → the dock focuses it; nothing navigates.
      fireEvent.click(here);
      expect(requests).toEqual(["here"]);
      expect(router.state.location.pathname).toBe("/");
      // ⌘/ctrl-click keeps the browser's open-in-new-tab: no request, no hook.
      fireEvent.click(here, { ctrlKey: true });
      expect(requests).toEqual(["here"]);
      // Wait for the workspaces LIST the hook consults to have landed.
      await waitFor(async () => expect(await listLoaded()).toBe(true));
      // Filed in ANOTHER workspace → the click arms the arrival focus for the
      // holder and navigates there; the cells unmount, which is the point.
      fireEvent.click(await linkFor("else"));
      await waitFor(() => expect(requests).toEqual(["here", "else"]));
      await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces/w2"));
      expect(takePaneFocusOnArrive()).toBe("else");
    } finally {
      unsub();
      restore();
    }
  });

  it("a click on an unfiled pane JOINS the workspace that exists (revision 2026-10-17)", async () => {
    const posted: string[] = [];
    const restore = mockFetch(posted);
    const unsub = onWorkspacePaneFocusRequest(() => false);
    localStorage.removeItem("subshell.lastWorkspaceId");
    try {
      const { router } = renderCell(
        <SubshellCell
          subshell={sub({ id: "newguy", name: "unfiled" })}
          focused={false}
          labels={{ nodeLabel: "m", agentLabel: "A" }}
        />,
      );
      const link = (await screen.findAllByRole("link"))[0] as HTMLElement;
      fireEvent.click(link);
      // The idempotent pane-add onto w2 — NOT a new `/api/workspaces` row:
      // a click never opens a second window on top of the one you have.
      await waitFor(() => expect(posted.length).toBe(1));
      expect(posted[0]).toContain("/api/workspaces/w2/panes");
      await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces/w2"));
      // The tab arrives focused, same as the filed-pane path.
      expect(takePaneFocusOnArrive()).toBe("newguy");
    } finally {
      unsub();
      restore();
    }
  });

  it("only an instance with NO workspace creates one around the clicked pane", async () => {
    const posted: string[] = [];
    const restore = mockFetch(posted, "none");
    const unsub = onWorkspacePaneFocusRequest(() => false);
    localStorage.removeItem("subshell.lastWorkspaceId");
    try {
      const { router } = renderCell(
        <SubshellCell
          subshell={sub({ id: "newguy", name: "unfiled" })}
          focused={false}
          labels={{ nodeLabel: "m", agentLabel: "A" }}
        />,
      );
      const link = (await screen.findAllByRole("link"))[0] as HTMLElement;
      fireEvent.click(link);
      await waitFor(() => expect(posted.length).toBe(1));
      // The create carries the pane and the name, exactly like a split's.
      expect(posted[0]).toMatch(/\/api\/workspaces$/);
      await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces/w-new"));
    } finally {
      unsub();
      restore();
    }
  });

  it("shows the bell for an owner's unseen push, not the fill or an initial", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <SubshellCell
          subshell={sub({ unseenPush: true })}
          focused={false}
          labels={{ nodeLabel: "mac-mini", agentLabel: "Claude Code", initial: "M" }}
        />,
      );
      const link = await screen.findByRole("link");
      expect(link.querySelector("svg")).toBeTruthy();
      // The initial is REPLACED by the bell, never stacked under it.
      expect(link.textContent).toBe("");
      // And the screen reader hears the bell too (2026-09-25 review): the
      // glyph is aria-hidden, so the accessible name must carry the SAME
      // announcement the dot gives, not just the state word.
      expect(link.getAttribute("aria-label")).toBe("auth-refactor: unseen notification (idle)");
    } finally {
      restore();
    }
  });

  it("keeps a grantee's unseen push a plain cell — the bell is owner-only", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <SubshellCell
          subshell={sub({ unseenPush: true, access: "view" })}
          focused={false}
          labels={{ nodeLabel: "mac-mini", agentLabel: "Claude Code", initial: "A" }}
        />,
      );
      const link = await screen.findByRole("link");
      expect(link.querySelector("svg")).toBeNull();
      expect(link.textContent).toBe("A");
    } finally {
      restore();
    }
  });

  it("carries the pane's initial in flat mode, and nothing in grouped mode", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <div>
          <SubshellCell
            subshell={sub({ id: "f" })}
            focused={false}
            labels={{ nodeLabel: "mbp", agentLabel: "Claude Code", initial: "A" }}
          />
          <SubshellCell
            subshell={sub({ id: "g" })}
            focused={false}
            labels={{ nodeLabel: "mbp", agentLabel: "Claude Code" }}
          />
        </div>,
      );
      const links = await screen.findAllByRole("link");
      expect(links[0]?.textContent).toBe("A");
      expect(links[1]?.textContent).toBe("");
    } finally {
      restore();
    }
  });

  it("merges the full-detail tooltip onto the cell itself, hover-reach on focus", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <SubshellCell subshell={sub()} focused={false} labels={{ nodeLabel: "mac-mini", agentLabel: "Claude Code" }} />,
      );
      const link = await screen.findByRole("link");
      expect(link.hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
      expect(link.getAttribute("title")).toBeNull();
      fireEvent.focus(link);
      // Composed through TooltipLabelledLines: each line is a block whose
      // LABEL is its own bolded span. Anchor on the label, walk up to the
      // popup, and assert the assembled text keeps every line whole.
      const nameLabel = await screen.findByText("Name:");
      expect(nameLabel.className).toContain("font-strong");
      const popup = nameLabel.closest("[class*='bg-popover']");
      expect(popup).not.toBeNull();
      expect(popup?.textContent).toContain("Name: auth-refactor");
      expect(popup?.textContent).toContain("Node: mac-mini");
      expect(popup?.textContent).toContain("Agent: Claude Code");
      expect(popup?.textContent).toContain("Status: idle");
      expect(popup?.textContent).toContain("Directory: /home/theo/projects/auth");
      // The side the operator asked for: the popup opens BELOW the cell, not
      // to its right (a right-side popup lands on the next cell in the rail).
      expect(popup?.getAttribute("data-side")).toBe("bottom");
    } finally {
      restore();
    }
  });
});

describe("SubshellCellGrid", () => {
  it("lays one cell per row in a wrapping grid", async () => {
    const restore = mockFetch();
    try {
      const rows = [sub({ id: "a", name: "one" }), sub({ id: "b", name: "two" })];
      renderCell(
        <SubshellCellGrid
          rows={rows}
          focusedId={null}
          labelsFor={() => ({ nodeLabel: "mac-mini", agentLabel: "Claude Code" })}
        />,
      );
      await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(2));
      // The right-click menu wraps each cell in its anchor span, so walk up
      // with `closest` rather than assuming the grid is the parent.
      const links = screen.getAllByRole("link");
      const grid = links[0]?.closest(".flex-wrap");
      expect(grid).not.toBeNull();
      expect(grid).toBe(links[1]?.closest(".flex-wrap"));
      // Every cell navigates; the grid itself is inert.
      expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/subshells/a", "/subshells/b"]);
      // No tint prop, no plate: the grouped grids render cells unwrapped.
      expect(links[0]?.closest("[class*='bg-node-tint']")).toBeNull();
    } finally {
      restore();
    }
  });

  it("renders a flat grid where a Needs-Attention row shows in its band AND its cluster (a duplicated id) without a key collision", async () => {
    const restore = mockFetch();
    try {
      // `x` is a spotlight row AND a member of n1's group, so `flatCellRows`
      // emits it twice. All cells forced to one tint so the run-merge folds them
      // into a SINGLE plate — the worst case for an id-keyed child list (review
      // MAJOR): position-keyed cells render every occurrence.
      const many = [sub({ id: "x", nodeId: "n1", unseenPush: true }), sub({ id: "y", nodeId: "n1" })];
      const groups = groupSubshellsByNode(many, [{ id: "n1", name: "m" }] as never, { limit: 8 });
      const xRow = many.find((r) => r.id === "x");
      if (!xRow) throw new Error("fixture broke");
      const flat = flatCellRows(groups, [], [xRow], new Set());
      expect(flat.map((r) => r.id).filter((i) => i === "x")).toHaveLength(2);
      renderCell(
        <SubshellCellGrid
          rows={flat}
          focusedId={null}
          labelsFor={() => ({ nodeLabel: "m", agentLabel: "A" })}
          tintOf={() => 0}
        />,
      );
      await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(flat.length));
      const hrefs = screen.getAllByRole("link").map((l) => l.getAttribute("href"));
      expect(hrefs.filter((h) => h === "/subshells/x")).toHaveLength(2); // both occurrences render
      expect(hrefs).toContain("/subshells/y");
    } finally {
      restore();
    }
  });
});
