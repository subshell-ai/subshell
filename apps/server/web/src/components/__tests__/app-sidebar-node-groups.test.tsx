import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppSidebar } from "@/components/app-sidebar";
import * as quickAdd from "@/components/quick-add";
import { formatWorkspaceDate } from "@/lib/workspace-name";
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
function stubFetch(
  subshells: SubshellView[],
  state: { failNodes: boolean } = { failNodes: false },
  workspaces: unknown[] = [],
  workspaceDetail?: unknown,
  draftWorkspaces: unknown[] = [],
): () => void {
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
        : // ?drafts=only (the rail's Drafts list) before the plain list, and the
          // detail (…/workspaces/<id>) before the list too — the extra path/query
          // segment is what tells the three reads apart.
          url.includes("drafts=only")
          ? draftWorkspaces
          : url.includes("/api/workspaces/")
            ? (workspaceDetail ?? { workspace: null, panes: [] })
            : url.includes("/api/workspaces")
              ? workspaces
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
 * nodes refetch a live user would get from focus/reconnect/invalidation.
 * ASYNC on purpose: the rail mounts Base UI TooltipRoots (the eye, the +, the
 * trashcan) that dispatch one store update a scheduled tick after commit, and
 * a test that clicks and asserts without ever awaiting would leave that update
 * to fire in the gap before the next hook — outside any acting scope. Draining
 * a few turns inside act() right here settles every mount the same way. */
async function renderRail(initialPath = "/"): Promise<{ client: QueryClient }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <AppSidebar /> });
  const children = ["/", "/workspaces", "/workspaces/$id", "/nodes", "/presets", "/settings", "/subshells/$id"].map(
    (path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await act(async () => {
    for (let tick = 0; tick < 3; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
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

afterEach(async () => {
  // The rail mounts Base UI TooltipRoots (the eye, the +, the row and header
  // reveals) that dispatch store updates on scheduled ticks after commit and
  // after unmount. Doing the cleanup INSIDE act() and draining a few turns
  // around it is the settle — the pattern mobile-install-dialog.test.tsx
  // documents, widened here because the rail's tooltip work lands on both
  // sides of the unmount.
  await act(async () => {
    cleanup();
    for (let tick = 0; tick < 3; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
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
    const { client } = await renderRail();
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
        // The reveal is a styled tooltip popup since 2026-09-24 (the rows'
        // zoom reason), and its trigger is the HEADER BUTTON itself — the
        // focusable element the reveal must be keyboard-reachable on (round-4
        // review: a span trigger inside the button could never see focus).
        expect(header.querySelector("span")?.getAttribute("title")).toBeNull();
        expect(header.hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
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
      // Same popup shape as the cold-failure case: trigger marker on the
      // button, no leftover native title anywhere in the header.
      const header = groupHeader("gone-node-xyz");
      expect(header.getAttribute("title")).toBeNull();
      expect(header.querySelector("span")?.getAttribute("title")).toBeNull();
      expect(header.hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
    });
  });

  it("opens the header reveal on focus, showing the full id", async () => {
    await withRail([subshell({ id: "a", nodeId: "gone-node-xyz" })], async () => {
      await waitFor(() => expect(groupHeaders()).toHaveLength(1));
      // Focus the BUTTON — what a keyboard user actually focuses. This is
      // real behavior now because the trigger merged onto it via `render`.
      fireEvent.focus(groupHeader("gone-node-xyz"));
      // The full id exists in the DOM nowhere else on the rail while shut —
      // finding it IS the popup.
      expect(await screen.findByText("gone-node-xyz")).toBeTruthy();
      // Leave it SHUT: a tooltip still open when the test ends has its close
      // dispatch land during the NEXT test's mount, outside any acting scope
      // (the React act warning this line silences). Blur cancels it.
      fireEvent.blur(groupHeader("gone-node-xyz"));
    });
  });

  it("gives a RESOLVED header no popup — the hover would repeat its own name", async () => {
    await withRail([subshell({ id: "a", name: "one", nodeId: "n1" })], async () => {
      await waitFor(() => expect(groupHeaders()).toHaveLength(1));
      fireEvent.focus(groupHeader("n1"));
      // Past the 300 ms open delay: still nothing. The header has no hover
      // content, because its hover would say only "mac-mini" again. The wait
      // runs INSIDE act(): it is the one window where an unrelated tooltip's
      // delayed mount update would otherwise land outside an acting scope.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 450));
      });
      expect(document.querySelector("[class*='text-body']")).toBeNull();
    });
  });

  // The reveal moved off the native `title` onto the styled tooltip (2026-09-24,
  // zoom scaling), so these assert the POPUP itself, opened by the keyboard
  // focus path the tooltip also implements. (Hover needs a pointer stack
  // happy-dom lacks; focus drives the same popup, and earns keyboard users
  // the reveal as a side effect.)
  it("gives every row a tooltip naming the node, the agent and the state", async () => {
    await withRail([subshell({ id: "a", name: "one", nodeId: "n1" })], async () => {
      const link = await waitFor(() => screen.getByRole("link", { name: /one/ }));
      expect(link.getAttribute("title")).toBeNull();
      fireEvent.focus(link);
      // The popup composes each line as a bold-label span plus its value
      // (TooltipLabelledLines), so anchor on the label, walk to the popup,
      // and assert every line is present in the assembled text. The newline
      // string form stays the tested contract of `subshellRowTooltip`
      // itself; this is its rendering.
      const nameLabel = await screen.findByText("Name:");
      const popup = nameLabel.closest("[class*='bg-popover']");
      expect(popup?.textContent).toContain("Name: one");
      expect(popup?.textContent).toContain("Node: mac-mini");
      expect(popup?.textContent).toContain("Agent: Claude Code");
      expect(popup?.textContent).toContain("Status: idle");
      expect(popup?.textContent).toContain("Directory: /Users/theo");
    });
  });

  it("falls back to the harness id when the plugin catalog does not name it", async () => {
    // A readable slug beats an empty line — the clone dialog makes the same trade.
    await withRail([subshell({ id: "a", name: "one", harnessId: "codex" })], async () => {
      const link = await waitFor(() => screen.getByRole("link", { name: /one/ }));
      fireEvent.focus(link);
      const nameLabel = await screen.findByText("Name:");
      const popup = nameLabel.closest("[class*='bg-popover']");
      expect(popup?.textContent).toContain("Agent: codex");
    });
  });
});

describe("collapsing the RAIL itself", () => {
  it("keeps the typed filter across a collapse (2026-09-25 review fix)", async () => {
    // The section unmounts while collapsed. That is only survivable because
    // the QUERY STATE lives in AppSidebar, not in the section's own state —
    // this test is the difference between the two designs.
    await withRail([subshell({ id: "a", name: "one" })], async () => {
      const input = await screen.findByLabelText("Filter subshells");
      fireEvent.change(input, { target: { value: "needle" } });
      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
      const again = (await screen.findByLabelText("Filter subshells")) as HTMLInputElement;
      expect(again.value).toBe("needle");
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

describe("the cross-agent comms section (operator ask 2026-09-25)", () => {
  const COMMS_KEY = "subshell.sidebarCommsOpen";
  afterEach(() => localStorage.removeItem(COMMS_KEY));

  it("files MCP-launched panes in their own section, out of the machine groups", async () => {
    await withRail(
      [
        subshell({ id: "h", name: "human-work", nodeId: "n1" }),
        subshell({ id: "c", name: "helper-bot", nodeId: "n1", crossAgent: true }),
      ],
      async () => {
        expect(groupList("n1").textContent).toContain("human-work");
        expect(groupList("n1").textContent).not.toContain("helper-bot");
        expect(groupList("cross-agent").textContent).toContain("helper-bot");
        // The section header cannot name a machine (it spans them), so the
        // ROW carries it: the subline of a comms row is its node, not its path.
        expect(groupList("cross-agent").textContent).toContain("mac-mini");
      },
    );
  });

  it("is CLOSED by default, unlike the machine groups, and its press opens and persists", async () => {
    await withRail([subshell({ id: "c", name: "helper-bot", crossAgent: true })], async () => {
      expect(groupHeader("cross-agent").getAttribute("aria-expanded")).toBe("false");
      // Hidden by class, never unmounted: the machine groups' rule, same here.
      expect(groupList("cross-agent").className).toContain("hidden");
      fireEvent.click(groupHeader("cross-agent"));
      await waitFor(() => expect(groupHeader("cross-agent").getAttribute("aria-expanded")).toBe("true"));
      expect(localStorage.getItem(COMMS_KEY)).toBe("1");
    });
  });

  it("a remembered open survives the remount", async () => {
    localStorage.setItem(COMMS_KEY, "1");
    await withRail([subshell({ id: "c", crossAgent: true })], async () => {
      expect(groupHeader("cross-agent").getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("an explicit shut keeps the closed default (the pref is not the machine group's set)", async () => {
    localStorage.setItem(COMMS_KEY, "0");
    await withRail([subshell({ id: "c", crossAgent: true })], async () => {
      expect(groupHeader("cross-agent").getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("renders no header at all when no pane is cross-agent", async () => {
    await withRail([subshell({ id: "a" })], async () => {
      expect(document.querySelector("button[aria-controls='sidebar-node-group-cross-agent']")).toBeNull();
    });
  });

  it("sits ABOVE the machine groups, under the Needs Attention spotlight (operator ask 2026-09-26)", async () => {
    await withRail(
      [
        subshell({ id: "a", name: "needs-me", nodeId: "n1", unseenPush: true }),
        subshell({ id: "h", name: "plain-work", nodeId: "local" }),
        subshell({ id: "c", name: "helper-bot", crossAgent: true }),
      ],
      async () => {
        await waitFor(() => expect(groupHeaders()).toHaveLength(3));
        // Order is the whole assertion: comms is a section first, the machines
        // after it. Nothing about the filter, the caps or the prefs moved.
        const order = groupHeaders().map((h) => h.getAttribute("aria-controls"));
        expect(order.indexOf("sidebar-node-group-cross-agent")).toBeLessThan(order.indexOf("sidebar-node-group-n1"));
        expect(order.indexOf("sidebar-node-group-cross-agent")).toBeLessThan(order.indexOf("sidebar-node-group-local"));
        // And directly under the spotlight: the Needs Attention section
        // precedes every group header in the document.
        const attention = document.querySelector('[aria-label="Needs Attention"]');
        if (!attention) throw new Error("no Needs Attention section rendered");
        for (const header of groupHeaders()) {
          // Ask the EARLIER node where the header sits: a header after the
          // spotlight carries DOCUMENT_POSITION_FOLLOWING.
          expect(attention.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
      },
    );
  });
});

describe("the eye toggle (operator ask 2026-09-27)", () => {
  const HIDDEN_KEY = "subshell.sidebarHiddenSections";

  afterEach(() => localStorage.removeItem(HIDDEN_KEY));

  it("hides and shows the whole Subshells section via the eye", async () => {
    await withRail([subshell({ id: "a", name: "one", nodeId: "local" })], async () => {
      // The rail's filter box is the tell that the section body is mounted.
      expect(screen.getByLabelText("Filter subshells")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Hide subshells" }));
      // Whole body gone: mode control, filter, groups — the eye is still there.
      await waitFor(() => expect(screen.queryByLabelText("Filter subshells")).toBeNull());
      expect(localStorage.getItem(HIDDEN_KEY)).toContain("subshells");
      fireEvent.click(screen.getByRole("button", { name: "Show subshells" }));
      await waitFor(() => expect(screen.getByLabelText("Filter subshells")).toBeTruthy());
    });
  });

  it("reads a hidden section back from storage on the next mount", async () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ subshells: true }));
    const restore = stubFetch([subshell({ id: "a", name: "one", nodeId: "local" })]);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({ openLaunch: () => {}, openNewWorkspace: () => {} });
    try {
      await renderRail();
      // The eye is ALWAYS drawn (it is the way back); it says Show, and the
      // rail never mounts — so this is a bare render, not `withRail`, whose
      // precondition waits on group headers the hidden section does not draw.
      await waitFor(() => expect(screen.getByRole("button", { name: "Show subshells" })).toBeTruthy());
      expect(screen.queryByLabelText("Filter subshells")).toBeNull();
    } finally {
      spy.mockRestore();
      restore();
    }
  });
});

describe("the Drafts section (operator ask 2026-09-27)", () => {
  const HIDDEN_KEY = "subshell.sidebarHiddenSections";
  const WS_COLLAPSED_KEY = "subshell.sidebarWsGroupsCollapsed";
  afterEach(() => {
    localStorage.removeItem(HIDDEN_KEY);
    localStorage.removeItem(WS_COLLAPSED_KEY);
  });

  const draft = (id: string, createdAt: string) => ({
    id,
    name: `DraftName-${id}`,
    draft: true,
    layout: null,
    subshellCount: 0,
    createdAt,
    updatedAt: createdAt,
  });

  it("lists every unsaved workspace by its creation stamp, not its stored name", async () => {
    // Two drafts with distinctive names. The row shows the creation date (so they
    // read like saved siblings), and on the home page — in no workspace — the
    // trashcan offers to discard ALL of them.
    const restore = stubFetch([], { failNodes: false }, [], undefined, [
      draft("w1", "2026-08-28T16:45:00.000Z"),
      draft("w2", "2026-09-01T09:05:00.000Z"),
    ]);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({ openLaunch: () => {}, openNewWorkspace: () => {} });
    try {
      await renderRail("/");
      await waitFor(() => expect(document.querySelector("a[href='/workspaces/w1']")).toBeTruthy());
      expect(document.querySelector("a[href='/workspaces/w2']")).toBeTruthy();
      expect(screen.getByText("Drafts")).toBeTruthy();
      expect(screen.queryByText("DraftName-w1")).toBeNull();
      expect(screen.getByRole("button", { name: "Discard all unsaved workspaces" })).toBeTruthy();
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("highlights the draft you are standing in", async () => {
    const restore = stubFetch([], { failNodes: false }, [], undefined, [draft("w1", "2026-08-28T16:45:00.000Z")]);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({ openLaunch: () => {}, openNewWorkspace: () => {} });
    try {
      await renderRail("/workspaces/w1");
      await waitFor(() => expect(document.querySelector("a[href='/workspaces/w1']")).toBeTruthy());
      const row = document.querySelector("a[href='/workspaces/w1']") as HTMLElement;
      expect(row.className).toContain("bg-accent");
      expect(screen.getByRole("button", { name: "Discard your other unsaved workspaces" })).toBeTruthy();
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("collapses a Workspaces section on its header and remembers it", async () => {
    const restore = stubFetch([], { failNodes: false }, [], undefined, [draft("w1", "2026-08-28T16:45:00.000Z")]);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({ openLaunch: () => {}, openNewWorkspace: () => {} });
    try {
      await renderRail("/");
      await waitFor(() => expect(document.getElementById("ws-group-drafts")).toBeTruthy());
      const header = screen.getByRole("button", { name: /^Drafts/ });
      expect(header.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(header);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /^Drafts/ }).getAttribute("aria-expanded")).toBe("false"),
      );
      expect(document.getElementById("ws-group-drafts")?.className).toContain("hidden");
      // The row is hidden by class, not unmounted (aria-controls stays real), and
      // the fold persists per device.
      expect(document.getElementById("ws-group-drafts")?.querySelector("a[href='/workspaces/w1']")).toBeTruthy();
      expect(localStorage.getItem(WS_COLLAPSED_KEY)).toContain("drafts");
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("offers to discard ALL drafts when you are standing in a SAVED workspace", async () => {
    // The bug this pins: the copy keyed off the URL alone, so standing on a
    // saved page promised "the one you're in stays" about a workspace that is
    // not one of the drafts the sweep targets — and sent it as `except` anyway.
    const saved = {
      id: "s1",
      name: "My saved",
      draft: false,
      layout: null,
      subshellCount: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
    };
    const restore = stubFetch([], { failNodes: false }, [saved], undefined, [draft("d1", "2026-08-28T16:45:00.000Z")]);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({ openLaunch: () => {}, openNewWorkspace: () => {} });
    try {
      await renderRail("/workspaces/s1");
      await waitFor(() => expect(document.querySelector("a[href='/workspaces/d1']")).toBeTruthy());
      expect(screen.getByRole("button", { name: "Discard all unsaved workspaces" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Discard your other unsaved workspaces" })).toBeNull();
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("tells two same-minute drafts apart in their labels", async () => {
    // The stamp is minute-granular; the SECOND draft of one minute carries the
    // stored name, so the rows never render (or search) identically.
    const restore = stubFetch([], { failNodes: false }, [], undefined, [
      draft("w1", "2026-08-28T16:45:00.000Z"),
      draft("w2", "2026-08-28T16:45:30.000Z"),
    ]);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({ openLaunch: () => {}, openNewWorkspace: () => {} });
    try {
      await renderRail("/");
      await waitFor(() => expect(document.querySelector("a[href='/workspaces/w2']")).toBeTruthy());
      const stamp = formatWorkspaceDate("2026-08-28T16:45:00.000Z");
      const labelOf = (id: string) => document.querySelector(`a[href='/workspaces/${id}']`)?.textContent ?? "";
      // Newest first: w2 is alone at its first appearance, so it wears the bare
      // stamp; w1 shares the minute and gains its name.
      expect(labelOf("w2")).toBe(stamp);
      expect(labelOf("w1")).toBe(`${stamp} · DraftName-w1`);
      expect(labelOf("w1")).not.toBe(labelOf("w2"));
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("keeps the box and the no-match line when a drafts-only search misses", async () => {
    // The vanishing act this pins: the presence gate read the FILTERED drafts,
    // so a user with nothing saved typing a non-matching query unmounted the
    // section — the input they were typing in — with no way to clear it.
    const restore = stubFetch([], { failNodes: false }, [], undefined, [draft("d1", "2026-08-28T16:45:00.000Z")]);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({ openLaunch: () => {}, openNewWorkspace: () => {} });
    try {
      await renderRail("/");
      const input = await screen.findByLabelText("Filter workspaces");
      fireEvent.change(input, { target: { value: "zzz" } });
      await waitFor(() => expect(screen.getByText("No workspaces match.")).toBeTruthy());
      expect(screen.getByLabelText("Filter workspaces")).toBeTruthy();
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("shows no Drafts section when there are none", async () => {
    const saved = {
      id: "s1",
      name: "My saved",
      draft: false,
      layout: null,
      subshellCount: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
    };
    const restore = stubFetch([], { failNodes: false }, [saved]);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({ openLaunch: () => {}, openNewWorkspace: () => {} });
    try {
      await renderRail("/");
      await waitFor(() => expect(screen.getByText("My saved")).toBeTruthy());
      expect(screen.queryByText("Drafts")).toBeNull();
    } finally {
      spy.mockRestore();
      restore();
    }
  });
});

describe("the workspace search filter (operator ask 2026-09-27)", () => {
  const ws = (id: string, name: string, updatedAt: string) => ({
    id,
    name,
    draft: false,
    layout: null,
    subshellCount: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
  });
  const draft = (id: string, name: string, createdAt: string) => ({
    id,
    name,
    draft: true,
    layout: null,
    subshellCount: 0,
    createdAt,
    updatedAt: createdAt,
  });
  const WS_COLLAPSED_KEY = "subshell.sidebarWsGroupsCollapsed";
  afterEach(() => localStorage.removeItem(WS_COLLAPSED_KEY));

  it("unfolds a folded section for a search match and keeps its header inert while searching", async () => {
    // The rail's filter idiom has two halves and the section needed both: a
    // match inside a folded section must not read as a broken search (force
    // open), and a press during that force must not persist a fold the user
    // cannot see happening (inert header).
    // The query must keep BOTH sections non-empty (a Saved header only
    // renders when a Drafts section does): "Doc" hits the saved "Docs" and,
    // via the same-minute dedup label, the second draft "Doc-thing".
    localStorage.setItem(WS_COLLAPSED_KEY, JSON.stringify({ saved: true }));
    const rows = [ws("w1", "Alpha", "2026-09-20T00:00:00.000Z"), ws("w2", "Docs", "2026-09-25T00:00:00.000Z")];
    const restore = stubFetch([], { failNodes: false }, rows, undefined, [
      draft("d1", "Doc-thing", "2026-08-28T16:45:00.000Z"),
      draft("d2", "Other", "2026-08-28T16:45:30.000Z"),
    ]);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({ openLaunch: () => {}, openNewWorkspace: () => {} });
    try {
      await renderRail("/");
      const savedHeader = () => screen.getByRole("button", { name: /^Saved/ }) as HTMLButtonElement;
      await waitFor(() => expect(savedHeader().getAttribute("aria-expanded")).toBe("false"));
      const input = await screen.findByLabelText("Filter workspaces");
      fireEvent.change(input, { target: { value: "Doc" } });
      await waitFor(() => expect(savedHeader().getAttribute("aria-expanded")).toBe("true"));
      // Inert while force-open: the button is disabled, and a press writes
      // nothing — the stored fold is exactly what was there before.
      expect(savedHeader().disabled).toBe(true);
      fireEvent.click(savedHeader());
      expect(savedHeader().getAttribute("aria-expanded")).toBe("true");
      expect(localStorage.getItem(WS_COLLAPSED_KEY)).toBe(JSON.stringify({ saved: true }));
      // Clearing the search returns the remembered fold.
      fireEvent.change(input, { target: { value: "" } });
      await waitFor(() => expect(savedHeader().getAttribute("aria-expanded")).toBe("false"));
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("filters the workspace list as you type, over the whole set", async () => {
    const rows = [ws("w1", "Alpha", "2026-09-20T00:00:00.000Z"), ws("w2", "Docs", "2026-09-25T00:00:00.000Z")];
    const restore = stubFetch([], { failNodes: false }, rows);
    const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({ openLaunch: () => {}, openNewWorkspace: () => {} });
    try {
      await renderRail();
      const input = await screen.findByLabelText("Filter workspaces");
      expect(screen.getByText("Alpha")).toBeTruthy();
      expect(screen.getByText("Docs")).toBeTruthy();
      // A partial narrows to the one hit.
      fireEvent.change(input, { target: { value: "Doc" } });
      await waitFor(() => expect(screen.queryByText("Alpha")).toBeNull());
      expect(screen.getByText("Docs")).toBeTruthy();
      // A no-match clears the list but KEEPS the box, so the text can be cleared.
      fireEvent.change(input, { target: { value: "zzz" } });
      await waitFor(() => expect(screen.getByText("No workspaces match.")).toBeTruthy());
      expect(screen.getByLabelText("Filter workspaces")).toBeTruthy();
    } finally {
      spy.mockRestore();
      restore();
    }
  });
});
