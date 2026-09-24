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
/**
 * `failNodes` is read AT REQUEST TIME so a test can flip it mid-life — that
 * is how the failed-REFRESH case (cache populated, refetch errors) is
 * distinguishable from the cold-failure case (nothing cached).
 */
function stubFetch(subshells: SubshellView[], state: { failNodes: boolean } = { failNodes: false }): () => void {
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if (state.failNodes && url.includes("/api/nodes")) {
      return new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
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

/** Renders the rail and hands back the QueryClient, so a test can force the
 * nodes refetch a live user would get from focus/reconnect/invalidation. */
function renderRail(): { client: QueryClient } {
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
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client };
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
const withRail = async (
  subshells: SubshellView[],
  body: (ctx: { client: QueryClient; failNodes: (on: boolean) => void }) => Promise<void> | void,
  opts: { failNodes?: boolean } = {},
) => {
  const state = { failNodes: opts.failNodes ?? false };
  const restoreFetch = stubFetch(subshells, state);
  const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
    openLaunch: () => {},
    openNewWorkspace: () => {},
  });
  try {
    const { client } = renderRail();
    await waitFor(() => expect(groupHeaders().length).toBeGreaterThan(0));
    await body({
      client,
      failNodes: (on: boolean) => {
        state.failNodes = on;
      },
    });
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

  it("wears the short id, not a verdict, when the nodes read FAILS with nothing cached", async () => {
    // `unanswered` must mean "no read has EVER succeeded" — an `isError` flag
    // would also fire on a failed background refresh of a POPULATED cache,
    // re-labelling resolved headers on a blip. With no cache the failure is
    // genuinely no answer: the id, not "unknown node" (and never the word
    // "deleted", which this rail must not assert about `local`).
    await withRail(
      [subshell({ id: "a", name: "one", nodeId: "mac-pro-abcdef" })],
      async () => {
        await waitFor(() => expect(groupHeaders()).toHaveLength(1));
        const header = groupHeader("mac-pro-abcdef");
        expect(header.textContent).toContain("mac-pro");
        expect(header.textContent).not.toContain("unknown node");
        expect(header.querySelector("span")?.getAttribute("title")).toBe("mac-pro-abcdef");
      },
      { failNodes: true },
    );
  });

  it("keeps every label through a FAILED BACKGROUND REFRESH of a populated cache", async () => {
    // THE case the two spellings of `unanswered` disagree on, so this is the
    // test the 35c7bf09 message promised and its cold-failure sibling is not:
    // TanStack reports `isError` on a failed refetch WHILE KEEPING `data`,
    // so `isPending || isError` would relabel the resolved header (and the
    // unresolved one, from "unknown node" to a short id) on a transient
    // blip. `nodeData === undefined` cannot: data is still there.
    await withRail(
      [subshell({ id: "a", name: "one", nodeId: "n1" }), subshell({ id: "b", name: "two", nodeId: "gone" })],
      async ({ client, failNodes }) => {
        await waitFor(() => expect(groupHeaders()).toHaveLength(2));
        expect(groupHeader("n1").textContent).toContain("mac-mini");
        expect(groupHeader("gone").textContent).toContain("unknown node");

        failNodes(true);
        await client.invalidateQueries({ queryKey: ["nodes"] });
        // Let the failed refetch LAND (the query enters error state with data
        // intact) rather than racing it, then assert NOTHING moved.
        await new Promise((r) => setTimeout(r, 50));
        expect(groupHeader("n1").textContent).toContain("mac-mini");
        expect(groupHeader("gone").textContent).toContain("unknown node");
      },
    );
  });

  it("puts the full node id on the header's hover text when the registry cannot name it", async () => {
    // The stub answers WITH local/n1, so force the unresolved case: a
    // subshell on an id nothing holds renders the label ladder's last rung,
    // and the id must be recoverable on hover.
    await withRail([subshell({ id: "a", nodeId: "gone-node-xyz" })], async () => {
      await waitFor(() => expect(groupHeaders()).toHaveLength(1));
      expect(groupHeader("gone-node-xyz").textContent).toContain("unknown node");
      expect(groupHeader("gone-node-xyz").querySelector("span")?.getAttribute("title")).toBe("gone-node-xyz");
    });
  });

  it("gives every row a tooltip naming the node, the agent and the state", async () => {
    await withRail([subshell({ id: "a", name: "one", nodeId: "n1" })], async () => {
      const link = await waitFor(() => screen.getByRole("link", { name: /one/ }));
      expect(link.getAttribute("title")).toBe(
        "Name: one\nNode: mac-mini\nAgent: Claude Code\nStatus: idle\nDirectory: /Users/theo",
      );
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
  it("leaves the header INERT while filtering — a press moves nothing and writes nothing", async () => {
    // The override alone was not enough: an enabled chevron under a forced
    // open would still write the collapse to storage, so clearing the filter
    // would reveal a group the user never saw themselves shut.
    localStorage.setItem(PREF_KEY, JSON.stringify(["local"]));
    await withRail([subshell({ id: "a", name: "needle" })], async () => {
      fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "needle" } });
      await waitFor(() => expect(groupHeader("local").getAttribute("aria-expanded")).toBe("true"));
      expect(groupHeader("local").hasAttribute("disabled")).toBe(true);
      fireEvent.click(groupHeader("local"));
      expect(groupHeader("local").getAttribute("aria-expanded")).toBe("true");
      expect(groupList("local").className).not.toContain("hidden");
      expect(JSON.parse(localStorage.getItem(PREF_KEY) ?? "[]")).toEqual(["local"]);
      // Clearing the filter hands control back, still honouring the ORIGINAL
      // (untouched) preference: shut.
      fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "" } });
      await waitFor(() => expect(groupHeader("local").hasAttribute("disabled")).toBe(false));
      expect(groupHeader("local").getAttribute("aria-expanded")).toBe("false");
    });
  });

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

/** The rail's Needs Attention region, found by the accessible name it now carries. */
function attentionRegion(): HTMLElement | null {
  return screen.queryByRole("region", { name: "Needs Attention" });
}

describe("the rail's Needs Attention spotlight (spec 2026-09-24)", () => {
  it("renders nothing when no pane has an unseen push", async () => {
    await withRail([subshell({ id: "a", name: "seen" })], async () => {
      await waitFor(() => expect(groupHeaders()).toHaveLength(1));
      expect(attentionRegion()).toBeNull();
    });
  });

  it("lists the owner's unseen rows above the first machine group", async () => {
    await withRail(
      [
        subshell({ id: "a", name: "waiting", nodeId: "n1", unseenPush: true }),
        subshell({ id: "b", name: "seen", nodeId: "local" }),
      ],
      async () => {
        await waitFor(() => expect(groupHeaders()).toHaveLength(2));
        const region = attentionRegion();
        if (!region) throw new Error("the rail rendered no Needs Attention region");
        expect(region.textContent).toContain("waiting");
        expect(region.textContent).not.toContain("seen");
        // Above every machine group: the region precedes the first group header
        // in document order, whatever the group sort did with the unseen row's
        // own node.
        const firstButton = groupHeaders()[0];
        if (!firstButton) throw new Error("the rail rendered no group header to order against");
        expect(region.compareDocumentPosition(firstButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
      },
    );
  });

  it("spotlights without extracting — the unseen row is ALSO in its node group", async () => {
    await withRail([subshell({ id: "a", name: "waiting", nodeId: "n1", unseenPush: true })], async () => {
      await waitFor(() => expect(groupHeaders()).toHaveLength(1));
      expect(attentionRegion()?.textContent).toContain("waiting");
      // The group it belongs to still lists it and still counts it; no row
      // jumps between groups when the pane is opened.
      expect(groupList("n1").textContent).toContain("waiting");
      expect(groupHeader("n1").textContent).toContain("1");
    });
  });

  it("excludes a grantee's unseen row from the owner's spotlight", async () => {
    await withRail([subshell({ id: "a", name: "shared", unseenPush: true, access: "view" })], async () => {
      await waitFor(() => expect(groupHeaders()).toHaveLength(1));
      expect(attentionRegion()).toBeNull();
    });
  });

  it("narrows with the filter and empties when no unseen row matches", async () => {
    await withRail(
      [
        subshell({ id: "a", name: "keep-me", unseenPush: true }),
        subshell({ id: "b", name: "other", unseenPush: true }),
      ],
      async () => {
        await waitFor(() => expect(attentionRegion()).not.toBeNull());
        fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "keep" } });
        await waitFor(() => expect(attentionRegion()?.textContent).toContain("keep-me"));
        expect(attentionRegion()?.textContent).not.toContain("other");

        fireEvent.change(screen.getByLabelText("Filter subshells"), { target: { value: "zzz-nomatch" } });
        await waitFor(() => expect(attentionRegion()).toBeNull());
      },
    );
  });
});
