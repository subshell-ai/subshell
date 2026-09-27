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
import { useRef, useState } from "react";
import { RailSubshells } from "@/components/sidebar/rail-subshells";
import { resetWorkspaceFocusForTests, setWorkspaceFocusedId } from "@/lib/workspace-focus";
import { setFetchRouter } from "@/test-setup";
import type { SubshellView } from "@/types/subshell";

/**
 * The rail's subshell section with its three rendering modes. The row tree's
 * own rules (group headers, collapse, inert-while-filtering, the spotlight,
 * the comms section) are pinned by `components/__tests__/app-sidebar-node-
 * groups.test.tsx` through the real AppSidebar — this file pins what is NEW:
 * the mode control switches renderings, the choice persists per device, the
 * cell modes show the same rows as rows mode (filter uncapped, all groups
 * forced open), and flat mode drops the headers for letters.
 */

const VIEW_KEY = "subshell.sidebarRailView";
const GROUPS_KEY = "subshell.sidebarNodeGroups";
const WORKSPACE_OPEN_KEY = "subshell.sidebarWorkspaceOpen";
const OTHERS_OPEN_KEY = "subshell.sidebarOthersOpen";

function sub(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    presetId: null,
    harnessId: "claude-code",
    nodeId: "local",
    nodeOffline: false,
    name: "s1",
    workingDir: "/Users/theo",
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

function stubFetch(subshells: SubshellView[], panes: readonly { subshellId: string }[] = []): () => void {
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = url.includes("/api/settings/public")
      ? { viewerIsAdmin: false, instanceName: "Test plane" }
      : url.includes("get-session")
        ? { user: { id: "u1", name: "Theo", email: "theo@test" } }
        : url.includes("/api/workspaces/")
          ? {
              workspace: {
                id: "w1",
                name: "ws",
                draft: false,
                layout: null,
                subshellCount: panes.length,
                createdAt: "2026-09-25T00:00:00.000Z",
                updatedAt: "2026-09-25T00:00:00.000Z",
              },
              panes: panes.map((p, i) => ({ id: `p${i}`, ...p })),
            }
          : url.includes("/api/subshells")
            ? subshells
            : url.includes("/api/nodes")
              ? {
                  nodes: [
                    { id: "local", name: "Server", kind: "local" },
                    { id: "n1", name: "mac-mini", kind: "agent" },
                  ],
                }
              : url.includes("/api/plugins")
                ? { plugins: [{ id: "claude-code", name: "Claude Code" }] }
                : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return () => setFetchRouter(null);
}

function renderSection(initialPath = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => {
      // The ⌘F flow hands a ref in, and the QUERY lives in the parent (the
      // section unmounts on collapse; the parent outlives it). The harness
      // mirrors that ownership rather than papering over it.
      const filterRef = useRef<HTMLInputElement>(null);
      const [query, setQuery] = useState("");
      return <RailSubshells filterRef={filterRef} query={query} onQueryChange={setQuery} />;
    },
  });
  const children = ["/", "/subshells/$id", "/workspaces/$id"].map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function groupHeaders(): HTMLElement[] {
  return [...document.querySelectorAll("button[aria-controls^='sidebar-node-group-']")] as HTMLElement[];
}

function cellLinks(): HTMLElement[] {
  return screen.queryAllByRole("link").filter((el) => el.className.includes("h-6")) as HTMLElement[];
}

/** A collapsible group's header button, by the synthetic/real id it controls. */
function groupHeader(nodeId: string): HTMLElement | null {
  return document.querySelector(`button[aria-controls='sidebar-node-group-${nodeId}']`);
}

/** A collapsible group's children container (hidden, not unmounted, when shut). */
function groupList(nodeId: string): HTMLElement | null {
  return document.getElementById(`sidebar-node-group-${nodeId}`);
}

async function withRail(
  subshells: SubshellView[],
  body: () => Promise<void> | void,
  opts: { path?: string; panes?: readonly { subshellId: string }[] } = {},
) {
  const restore = stubFetch(subshells, opts.panes);
  try {
    // Tear down any tree a previous `withRail` left in the document: the DOM
    // queries here are document-wide, so a second call in one test would
    // otherwise read both renders' headers/cells.
    cleanup();
    renderSection(opts.path ?? "/");
    // Wait on the rows themselves, not on headers: flat mode renders none,
    // and the data landing is the precondition for every body below.
    await waitFor(() => expect(document.querySelectorAll("a[href^='/subshells/']").length).toBeGreaterThan(0));
    await body();
  } finally {
    restore();
  }
}

afterEach(() => {
  cleanup();
  resetWorkspaceFocusForTests();
  localStorage.removeItem(VIEW_KEY);
  localStorage.removeItem(GROUPS_KEY);
  localStorage.removeItem(WORKSPACE_OPEN_KEY);
  localStorage.removeItem(OTHERS_OPEN_KEY);
});

describe("the rail view control", () => {
  it("defaults to rows — the mode control does not change what is rendered", async () => {
    await withRail(
      [sub({ id: "a", name: "one", nodeId: "local" }), sub({ id: "b", name: "two", nodeId: "n1" })],
      () => {
        // Rows mode: text rows, no squares.
        expect(screen.getByRole("link", { name: /one/ })).toBeTruthy();
        expect(cellLinks()).toHaveLength(0);
        expect(screen.getByRole("button", { name: "Row view" }).getAttribute("aria-pressed")).toBe("true");
      },
    );
  });

  it("switches to cells: same groups and headers, text rows replaced by squares", async () => {
    await withRail(
      [sub({ id: "a", name: "one", nodeId: "local" }), sub({ id: "b", name: "two", nodeId: "n1" })],
      () => {
        fireEvent.click(screen.getByRole("button", { name: "Cell view" }));
        expect(groupHeaders()).toHaveLength(2);
        // No text row survives the mode: every link in the section is now a
        // square, and the name shows only in the aria-label and the tooltip.
        const links = screen.getAllByRole("link");
        expect(links).toHaveLength(2);
        expect(cellLinks()).toHaveLength(2);
        expect(screen.getByRole("link", { name: "one: idle" })).toBeTruthy();
        // Grouped cells sit under headers that name the machine — no tint
        // plates here; the plate is flat mode's machine cue.
        expect(document.querySelectorAll("[class*='bg-node-tint']")).toHaveLength(0);
        expect(localStorage.getItem(VIEW_KEY)).toBe("cells");
      },
    );
  });

  it("switches to cells-flat: no headers, one grid, pane letters on machine-tint plates", async () => {
    await withRail(
      [sub({ id: "a", name: "one", nodeId: "local" }), sub({ id: "b", name: "two", nodeId: "n1" })],
      () => {
        fireEvent.click(screen.getByRole("button", { name: "Flat cell view" }));
        expect(groupHeaders()).toHaveLength(0);
        const links = cellLinks();
        expect(links).toHaveLength(2);
        // The glyph is the PANE's first letter; the machine reads from the
        // plate tint and the tooltip's Node line, not from a letter.
        expect(links.map((l) => l.textContent).sort()).toEqual(["O", "T"]);
        // Every flat cell rides a machine-tint plate hashed from its node name.
        expect(links.every((l) => l.closest("[class*='bg-node-tint']") !== null)).toBe(true);
        expect(localStorage.getItem(VIEW_KEY)).toBe("cells-flat");
      },
    );
  });

  it("the mode buttons explain themselves on hover-reach (operator ask)", async () => {
    await withRail([sub({ id: "a", name: "one" })], async () => {
      fireEvent.focus(screen.getByRole("button", { name: "Cell view" }));
      expect(await screen.findByText("Status cells, grouped by machine")).toBeTruthy();
    });
  });

  it("the mode toggle renders dense buttons (operator: half the button padding)", async () => {
    await withRail([sub({ id: "a", name: "one" })], () => {
      // The rail's view switch opts into Segmented's `dense` (h-6, the cell
      // grid's own rhythm) — the vertical saving is the buttons' air, not the
      // gap to the filter box (operator correction 2026-09-25).
      for (const name of ["Row view", "Cell view", "Flat cell view"]) {
        expect(screen.getByRole("button", { name }).className).toContain("h-6");
      }
    });
  });

  it("every mode button renders its icon — DOM, not props (operator: blank pills live)", async () => {
    await withRail([sub({ id: "a", name: "one" })], () => {
      // Regression pin: composing the option tooltip through Base UI's
      // `render` merge can drop the Button's children if the element handed
      // to `render` carries its own (even `null`), which is how the live rail
      // showed blank pills. Assert on the rendered DOM only.
      for (const name of ["Row view", "Cell view", "Flat cell view"]) {
        const btn = screen.getByRole("button", { name });
        expect(btn.querySelector("svg")).toBeTruthy();
        expect(btn.getAttribute("aria-pressed")).toBeTruthy();
      }
    });
  });

  it("a remembered mode applies on the next mount", async () => {
    localStorage.setItem(VIEW_KEY, "cells-flat");
    await withRail([sub({ id: "a", nodeId: "n1" })], () => {
      expect(groupHeaders()).toHaveLength(0);
      expect(cellLinks()).toHaveLength(1);
    });
  });
});

describe("the cell modes keep the row tree's facts", () => {
  it("cells mode: filtering forces everything visible and uncapped", async () => {
    // 10 matches on one machine: past RECENT_LIMIT, so a capped cell grid
    // would show 8 and lie about the search exactly like a capped row list
    // would.
    const many = Array.from({ length: 10 }, (_, i) => sub({ id: `m${i}`, name: `needle-${i}`, nodeId: "n1" }));
    await withRail(many, () => {
      fireEvent.click(screen.getByRole("button", { name: "Cell view" }));
      expect(cellLinks()).toHaveLength(8); // capped when unfiltered
      fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "needle" } });
      expect(cellLinks()).toHaveLength(10);
      expect(groupHeaders()[0]?.getAttribute("aria-expanded")).toBe("true");
      expect(groupHeaders()[0]?.hasAttribute("disabled")).toBe(true);
    });
  });

  it("flat mode shows the same set the groups would, and follows the filter", async () => {
    await withRail(
      [sub({ id: "a", name: "keep", nodeId: "local" }), sub({ id: "b", name: "skip", nodeId: "n1" })],
      () => {
        fireEvent.click(screen.getByRole("button", { name: "Flat cell view" }));
        expect(cellLinks()).toHaveLength(2);
        fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "keep" } });
        expect(cellLinks()).toHaveLength(1);
        expect(cellLinks()[0]?.getAttribute("aria-label")).toContain("keep:");
      },
    );
  });
});

describe("a workspace's selection (operator ask 2026-09-27)", () => {
  const nodeOf = (header: HTMLElement | undefined) => header?.getAttribute("aria-controls") ?? "";

  it("rings the focused pane alone; the rest of the open set wears the dim frame", async () => {
    // Standing in /workspaces/w1 with a AND b open. Only the focused `a`
    // wears the full-white ring; open-but-unfocused `b` wears the SAME dim
    // white frame as any unselected cell — the operator's final ruling
    // 2026-09-27, which killed the set-wide cell ring ("when in a workspace,
    // ALL items have a white border"). The set still decides ordering and
    // click-to-focus, and `b` keeps both. Focus arrives through the
    // workspace-focus store the dock publishes.
    setWorkspaceFocusedId("a");
    await withRail(
      [sub({ id: "a", name: "one", nodeId: "local" }), sub({ id: "b", name: "two", nodeId: "n1" })],
      async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cell view" }));
        // Each open pane now renders TWICE (the new Workspace section AND its
        // machine group, per "also keep in machine groups"): 4 cells, not 2.
        await waitFor(() => expect(cellLinks()).toHaveLength(4));
        // The Workspace section leads, in pane order; the same two then repeat
        // under their machines below.
        expect(
          cellLinks()
            .slice(0, 2)
            .map((l) => l.getAttribute("href")),
        ).toEqual(["/subshells/a", "/subshells/b"]);
        // The ring, width 1, on the focused pane alone — the bare
        // `ring-1`/`ring-foreground` tokens appear in EVERY rendering of `a`
        // (it appears twice: Workspace section + machine group) and in NONE
        // of `b`'s, which wears `border-foreground/25` like every other cell.
        // TOKENS, not substring: `hover:ring-foreground` would match a bare
        // claim. The retired orchid must be gone from both.
        const allToks = (id: string) =>
          cellLinks()
            .filter((l) => l.getAttribute("href") === `/subshells/${id}`)
            .map((l) => l.className.split(/\s+/));
        expect(allToks("a")).toHaveLength(2);
        expect(allToks("b")).toHaveLength(2);
        for (const toks of allToks("a")) {
          expect(toks).toContain("ring-1");
          expect(toks).toContain("ring-foreground");
          expect(toks).toContain("border-0");
          expect(toks).not.toContain("ring-2");
          expect(toks).not.toContain("ring-primary");
        }
        for (const toks of allToks("b")) {
          expect(toks).not.toContain("ring-1");
          expect(toks).not.toContain("ring-foreground");
          expect(toks).not.toContain("ring-primary");
          expect(toks).toContain("border-foreground/25");
        }
      },
      { path: "/workspaces/w1", panes: [{ subshellId: "a" }, { subshellId: "b" }] },
    );
  });

  it("puts the open panes in a topmost Workspace group, still kept in machine groups", async () => {
    // Rows mode (the default). The Workspace group is an ADDITION, not a move:
    // it holds both panes at the very top, and they still appear under their
    // machine groups (operator answer "also keep in machine groups"). It is a
    // collapsible group like comms, filed under a synthetic `workspace` id.
    await withRail(
      [sub({ id: "a", name: "one", nodeId: "local" }), sub({ id: "b", name: "two", nodeId: "n1" })],
      async () => {
        await waitFor(() => expect(groupHeader("workspace")).toBeTruthy());
        const order = groupHeaders().map((h) => h.getAttribute("aria-controls") ?? "");
        // Topmost: the Workspace group header is the very first group header.
        expect(order.indexOf("sidebar-node-group-workspace")).toBe(0);
        const list = groupList("workspace");
        expect(list?.textContent).toContain("one");
        expect(list?.textContent).toContain("two");
        // Both panes still show their machine as a group below it.
        expect(order).toContain("sidebar-node-group-local");
        expect(order).toContain("sidebar-node-group-n1");
      },
      { path: "/workspaces/w1", panes: [{ subshellId: "a" }, { subshellId: "b" }] },
    );
  });

  it("names each Workspace row's machine on a third line (list view)", async () => {
    // Operator 2026-09-27: "in the list view, for items under the workspace, a
    // third line item which would be the node name." The Workspace group spans
    // hosts, so its header cannot say which machine a row is on the way a node
    // group's can — the machine rides on the row instead.
    await withRail(
      [sub({ id: "a", name: "one", nodeId: "local" }), sub({ id: "b", name: "two", nodeId: "n1" })],
      async () => {
        await waitFor(() => expect(groupList("workspace")).toBeTruthy());
        const list = groupList("workspace");
        // The node NAMES (Server for local, mac-mini for n1) appear inside the
        // group as the rows' third line, not only as the machine headers below.
        expect(list?.textContent).toContain("Server");
        expect(list?.textContent).toContain("mac-mini");
      },
      { path: "/workspaces/w1", panes: [{ subshellId: "a" }, { subshellId: "b" }] },
    );
  });

  it("collapses the Workspace group on its own preference", async () => {
    // Operator ask 2026-09-27: "can the workspace section be collapsible too".
    // It folds like any other group and defaults OPEN (the work you came to
    // look at), persisting its shut state per device.
    await withRail(
      [sub({ id: "a", name: "one", nodeId: "local" }), sub({ id: "b", name: "two", nodeId: "n1" })],
      async () => {
        await waitFor(() => expect(groupHeader("workspace")).toBeTruthy());
        const header = groupHeader("workspace");
        expect(header?.getAttribute("aria-expanded")).toBe("true"); // open by default
        expect(groupList("workspace")?.className).not.toContain("hidden");
        // A press shuts it; the children hide rather than unmount, and the
        // choice is remembered for this device.
        if (header) fireEvent.click(header);
        await waitFor(() => expect(groupHeader("workspace")?.getAttribute("aria-expanded")).toBe("false"));
        expect(groupList("workspace")?.className).toContain("hidden");
        expect(localStorage.getItem(WORKSPACE_OPEN_KEY)).toBe("0");
      },
      { path: "/workspaces/w1", panes: [{ subshellId: "a" }, { subshellId: "b" }] },
    );
  });

  it("splits the flat view into Workspace and Others, only while a workspace is active", async () => {
    // Operator 2026-09-27: the ungrouped grid gets a second labelled section for
    // the rest, and BOTH distinguishing sections appear only while a workspace
    // is open — off a workspace page the flat view stays one headerless grid.
    const rows = [
      sub({ id: "a", name: "one", nodeId: "local" }),
      sub({ id: "b", name: "two", nodeId: "n1" }),
      sub({ id: "c", name: "rest", nodeId: "local" }),
    ];
    // Off a workspace page: no section headers, the whole grid at once.
    await withRail(rows, () => {
      fireEvent.click(screen.getByRole("button", { name: "Flat cell view" }));
      expect(groupHeader("workspace")).toBeNull();
      expect(groupHeader("others")).toBeNull();
      expect(cellLinks()).toHaveLength(3);
    });
    // On a workspace page holding a + b: Workspace lists the two panes, Others
    // lists only `c` — the rest, not a re-listing of the panes.
    await withRail(
      rows,
      async () => {
        fireEvent.click(screen.getByRole("button", { name: "Flat cell view" }));
        await waitFor(() => expect(groupHeader("workspace")).toBeTruthy());
        expect(groupHeader("others")).toBeTruthy();
        const hrefs = (id: string) =>
          [...(groupList(id)?.querySelectorAll("a[href^='/subshells/']") ?? [])].map((a) => a.getAttribute("href"));
        expect(hrefs("workspace")).toEqual(["/subshells/a", "/subshells/b"]); // the two panes
        expect(hrefs("others")).toEqual(["/subshells/c"]); // just the rest, not a re-listing
      },
      { path: "/workspaces/w1", panes: [{ subshellId: "a" }, { subshellId: "b" }] },
    );
  });

  it("promotes the machine group holding a selected pane above a more-urgent one", async () => {
    // n1's pane is WAITING (urgency rank 0); the selected pane sits on `local`,
    // which is merely idle (rank 2). Selection outranks urgency across MACHINE
    // groups, so `local` leads n1 when its pane is open in the workspace (the
    // Workspace pseudo-group stays first regardless).
    const rows = [
      sub({ id: "a", name: "urg", nodeId: "n1", waitingSince: "2026-09-25T00:00:00.000Z" }),
      sub({ id: "b", name: "sel", nodeId: "local" }),
    ];
    // Baseline: no selection (not on a workspace page) → the urgent n1 leads.
    await withRail(rows, () => {
      expect(groupHeaders()).toHaveLength(2);
      expect(nodeOf(groupHeaders()[0])).toContain("n1");
    });
    // With `b` (on local) open in the workspace → local's machine group is
    // promoted above n1's. `waitFor`: the pane set arrives on the workspace
    // query, a tick behind the rows the harness already waited on.
    await withRail(
      rows,
      async () => {
        await waitFor(() => {
          const order = groupHeaders().map((h) => h.getAttribute("aria-controls") ?? "");
          expect(order.indexOf("sidebar-node-group-local")).toBeLessThan(order.indexOf("sidebar-node-group-n1"));
        });
      },
      { path: "/workspaces/w1", panes: [{ subshellId: "b" }] },
    );
  });
});

describe("collapse / expand all (operator ask 2026-09-27)", () => {
  it("folds every machine group at once, then opens them again", async () => {
    await withRail(
      [sub({ id: "a", name: "alpha", nodeId: "n1" }), sub({ id: "b", name: "beta", nodeId: "local" })],
      async () => {
        // Both machine groups greet open.
        expect(groupHeaders()).toHaveLength(2);
        expect(groupHeader("n1")?.getAttribute("aria-expanded")).toBe("true");
        const collapse = screen.getByRole("button", { name: "Collapse all groups" });
        fireEvent.click(collapse);
        await waitFor(() => {
          expect(groupHeader("n1")?.getAttribute("aria-expanded")).toBe("false");
          expect(groupHeader("local")?.getAttribute("aria-expanded")).toBe("false");
        });
        // The control now names the opposite action, and does it.
        const expand = screen.getByRole("button", { name: "Expand all groups" });
        fireEvent.click(expand);
        await waitFor(() => {
          expect(groupHeader("n1")?.getAttribute("aria-expanded")).toBe("true");
          expect(groupHeader("local")?.getAttribute("aria-expanded")).toBe("true");
        });
      },
    );
  });

  it("folds the Workspace group too when a workspace is open", async () => {
    await withRail(
      [sub({ id: "a", name: "one", nodeId: "local" }), sub({ id: "b", name: "two", nodeId: "n1" })],
      async () => {
        await waitFor(() => expect(groupHeader("workspace")).toBeTruthy());
        fireEvent.click(screen.getByRole("button", { name: "Collapse all groups" }));
        await waitFor(() => expect(groupHeader("workspace")?.getAttribute("aria-expanded")).toBe("false"));
      },
      { path: "/workspaces/w1", panes: [{ subshellId: "a" }, { subshellId: "b" }] },
    );
  });

  it("in ROWS view neither writes nor counts the Others fold (2026-09-27 review)", async () => {
    // The flat view's "Others" section has no header outside cells-flat, so
    // the shared control must leave its preference alone. The old code wrote
    // it on every collapse and read it into "all collapsed", which left rows
    // view offering "Collapse" over an already-folded rail.
    await withRail(
      [sub({ id: "a", name: "one", nodeId: "local" }), sub({ id: "c", name: "three", nodeId: "n1" })],
      async () => {
        await waitFor(() => expect(groupHeader("workspace")).toBeTruthy());
        fireEvent.click(screen.getByRole("button", { name: "Collapse all groups" }));
        await waitFor(() => expect(groupHeader("workspace")?.getAttribute("aria-expanded")).toBe("false"));
        // The fold the rows view cannot see stays unwritten; the ones it draws
        // are not.
        expect(localStorage.getItem(OTHERS_OPEN_KEY)).toBeNull();
        expect(localStorage.getItem(WORKSPACE_OPEN_KEY)).toBe("0");
      },
      { path: "/workspaces/w1", panes: [{ subshellId: "a" }] },
    );
  });

  it("reads as fully folded in ROWS view while an unseen Others pref says open", async () => {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(["local", "n1"]));
    localStorage.setItem(WORKSPACE_OPEN_KEY, "0");
    localStorage.setItem(OTHERS_OPEN_KEY, "1");
    await withRail(
      [sub({ id: "a", name: "one", nodeId: "local" }), sub({ id: "c", name: "three", nodeId: "n1" })],
      async () => {
        await waitFor(() => expect(groupHeader("workspace")?.getAttribute("aria-expanded")).toBe("false"));
        // Every group the rows view draws is shut, so the control names the
        // opening action — the open-but-invisible Others fold cannot hold it
        // to "Collapse all groups".
        expect(screen.getByRole("button", { name: "Expand all groups" })).toBeTruthy();
      },
      { path: "/workspaces/w1", panes: [{ subshellId: "a" }] },
    );
  });

  it("is inert while a filter forces the groups open", async () => {
    await withRail([sub({ id: "a", name: "alpha", nodeId: "n1" })], () => {
      fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "alpha" } });
      const btn = screen.getByRole("button", { name: /all groups/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
  });
});
