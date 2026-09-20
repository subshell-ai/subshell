import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppSidebar } from "@/components/app-sidebar";
import * as quickAdd from "@/components/quick-add";
import { setFetchRouter } from "@/test-setup";
import type { SubshellView } from "@/types/subshell";

/**
 * The rail's subshell list, grouped by the MACHINE each subshell runs on
 * (2026-09-20). The grouping RULE is pinned by
 * `lib/__tests__/subshell-node-groups.test.ts`; what lives here is everything
 * that rule cannot see — that a header renders per node with the node's own
 * NAME, that a press collapses and the choice survives a remount, and that a
 * filter overrides a shut group rather than hiding its own matches.
 */

const PREF_KEY = "subshell.sidebarNodeGroups";

function subshell(over: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    presetId: null,
    harnessId: "claude-code",
    nodeId: "local",
    nodeOffline: false,
    name: "s1",
    workingDir: "/Users/theo",
    status: "running",
    createdAt: "2026-09-20T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    preview: [],
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    nameLocked: false,
    notify: true,
    waitingSince: null,
    access: "owner",
    shareCount: 0,
    sharedWithEveryone: false,
    ...over,
  } as SubshellView;
}

/**
 * Answers every query the rail mounts. Through `setFetchRouter` rather than a
 * seeded cache: these queries are stale-on-mount, so a background refetch
 * would overwrite seeded data with whatever the stub said — the fixture has to
 * BE the stub. (The better-auth binding reason is in app-sidebar-group.test.)
 */
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

function renderRail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <AppSidebar /> });
  const children = ["/", "/workspaces", "/nodes", "/presets", "/settings", "/subshells/$id"].map((path) =>
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

/** The node-group headers, in rendered order — found by what they control. */
function groupHeaders(): HTMLElement[] {
  return [...document.querySelectorAll("button[aria-controls^='sidebar-node-group-']")] as HTMLElement[];
}

function groupHeader(nodeId: string): HTMLElement {
  const el = document.querySelector(`button[aria-controls='sidebar-node-group-${nodeId}']`);
  if (!el) throw new Error(`no group header for node ${nodeId}`);
  return el as HTMLElement;
}

/** A group's children container, by the id its header points `aria-controls` at. */
function groupList(nodeId: string): HTMLElement {
  const el = document.getElementById(`sidebar-node-group-${nodeId}`);
  if (!el) throw new Error("the group header's aria-controls names no element");
  return el;
}

afterEach(() => {
  cleanup();
  localStorage.removeItem(PREF_KEY);
});

/** The rail calls useQuickAdd(), which throws outside its provider. */
const withRail = async (subshells: SubshellView[], body: () => Promise<void> | void) => {
  const restoreFetch = stubFetch(subshells);
  const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
    openLaunch: () => {},
    openNewWorkspace: () => {},
  });
  try {
    renderRail();
    await waitFor(() => expect(groupHeaders().length).toBeGreaterThan(0));
    await body();
  } finally {
    spy.mockRestore();
    restoreFetch();
  }
};

describe("the rail's subshell list, grouped by node", () => {
  it("renders one header per node, labelled by the node's NAME", async () => {
    await withRail([subshell({ id: "a", nodeId: "local" }), subshell({ id: "b", nodeId: "n1" })], async () => {
      await waitFor(() => expect(groupHeaders()).toHaveLength(2));
      // The label is `node.name`, never the id — an admin renaming a node has
      // to reach this rail (AGENTS.md).
      expect(groupHeader("local").textContent).toContain("Server");
      expect(groupHeader("n1").textContent).toContain("mac-mini");
      expect(groupHeader("local").textContent).not.toContain("local");
    });
  });

  it("groups even when every subshell is on one node", async () => {
    // The operator's call: the shape is the same at one machine as at five.
    await withRail([subshell({ id: "a" }), subshell({ id: "b" })], async () => {
      await waitFor(() => expect(groupHeaders()).toHaveLength(1));
      expect(groupHeader("local").textContent).toContain("Server");
    });
  });

  it("puts each row under its own node, and states the count", async () => {
    await withRail(
      [subshell({ id: "a", name: "one", nodeId: "local" }), subshell({ id: "b", name: "two", nodeId: "n1" })],
      async () => {
        await waitFor(() => expect(groupHeaders()).toHaveLength(2));
        expect(groupList("local").textContent).toContain("one");
        expect(groupList("local").textContent).not.toContain("two");
        expect(groupList("n1").textContent).toContain("two");
        expect(groupHeader("local").textContent).toContain("1");
      },
    );
  });

  it("gives every row a tooltip naming the node, the agent and the state", async () => {
    await withRail([subshell({ id: "a", name: "one", nodeId: "n1" })], async () => {
      const link = await waitFor(() => screen.getByRole("link", { name: /one/ }));
      expect(link.getAttribute("title")).toBe("Node: mac-mini\nAgent: Claude Code\nStatus: idle");
    });
  });

  it("falls back to the harness id when the plugin catalog does not name it", async () => {
    // A readable slug beats an empty line — the clone dialog makes the same trade.
    await withRail([subshell({ id: "a", name: "one", harnessId: "codex" })], async () => {
      const link = await waitFor(() => screen.getByRole("link", { name: /one/ }));
      expect(link.getAttribute("title")).toContain("Agent: codex");
    });
  });
});

describe("collapsing a node group", () => {
  it("opens by default, shuts on a press, and hides its rows", async () => {
    await withRail([subshell({ id: "a", name: "one" })], async () => {
      expect(groupHeader("local").getAttribute("aria-expanded")).toBe("true");
      expect(groupList("local").className).not.toContain("hidden");
      fireEvent.click(groupHeader("local"));
      await waitFor(() => expect(groupHeader("local").getAttribute("aria-expanded")).toBe("false"));
      // Hidden by class rather than unmounted, so `aria-controls` keeps
      // resolving and the links leave the tab order.
      expect(groupList("local").className).toContain("hidden");
      expect(groupList("local").textContent).toContain("one");
    });
  });

  it("persists the choice to this device", async () => {
    await withRail([subshell({ id: "a" })], async () => {
      fireEvent.click(groupHeader("local"));
      await waitFor(() => expect(groupHeader("local").getAttribute("aria-expanded")).toBe("false"));
      expect(JSON.parse(localStorage.getItem(PREF_KEY) ?? "[]")).toEqual(["local"]);
    });
  });

  it("restores a shut group on a later mount", async () => {
    localStorage.setItem(PREF_KEY, JSON.stringify(["local"]));
    await withRail([subshell({ id: "a" })], async () => {
      expect(groupHeader("local").getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("re-opens on a second press, and forgets the id", async () => {
    localStorage.setItem(PREF_KEY, JSON.stringify(["local"]));
    await withRail([subshell({ id: "a" })], async () => {
      fireEvent.click(groupHeader("local"));
      await waitFor(() => expect(groupHeader("local").getAttribute("aria-expanded")).toBe("true"));
      expect(JSON.parse(localStorage.getItem(PREF_KEY) ?? "[]")).toEqual([]);
    });
  });
});

describe("filtering across groups", () => {
  it("forces every group open — a match hidden inside a shut group reads as a broken filter", async () => {
    localStorage.setItem(PREF_KEY, JSON.stringify(["local"]));
    await withRail([subshell({ id: "a", name: "needle" })], async () => {
      expect(groupHeader("local").getAttribute("aria-expanded")).toBe("false");
      fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "needle" } });
      await waitFor(() => expect(groupHeader("local").getAttribute("aria-expanded")).toBe("true"));
      expect(groupList("local").className).not.toContain("hidden");
      // …and the preference is untouched: the override is for the search, not
      // a silent un-collapse the user did not ask for.
      expect(JSON.parse(localStorage.getItem(PREF_KEY) ?? "[]")).toEqual(["local"]);
    });
  });

  it("drops a group whose node has no match, and says so when nothing matches at all", async () => {
    await withRail(
      [subshell({ id: "a", name: "needle", nodeId: "local" }), subshell({ id: "b", name: "other", nodeId: "n1" })],
      async () => {
        await waitFor(() => expect(groupHeaders()).toHaveLength(2));
        fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "needle" } });
        await waitFor(() => expect(groupHeaders()).toHaveLength(1));
        expect(groupHeaders()[0]?.textContent).toContain("Server");

        fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "zzz" } });
        await waitFor(() => expect(groupHeaders()).toHaveLength(0));
        expect(screen.getByText("No matches.")).toBeTruthy();
      },
    );
  });
});
