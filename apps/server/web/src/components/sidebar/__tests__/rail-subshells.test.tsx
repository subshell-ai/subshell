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

function stubFetch(subshells: SubshellView[]): () => void {
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = url.includes("/api/settings/public")
      ? { viewerIsAdmin: false, instanceName: "Test plane" }
      : url.includes("get-session")
        ? { user: { id: "u1", name: "Theo", email: "theo@test" } }
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

function renderSection() {
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
  const children = ["/", "/subshells/$id"].map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: ["/"] }),
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

async function withRail(subshells: SubshellView[], body: () => Promise<void> | void) {
  const restore = stubFetch(subshells);
  try {
    renderSection();
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
  localStorage.removeItem(VIEW_KEY);
  localStorage.removeItem(GROUPS_KEY);
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
