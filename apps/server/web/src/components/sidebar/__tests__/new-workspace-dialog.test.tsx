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
import { NewWorkspaceDialog } from "@/components/sidebar/new-workspace-dialog";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

const subshell = (id: string, name: string): SubshellView =>
  ({
    id,
    name,
    workingDir: `/tmp/${id}`,
    harnessId: "claude",
    status: "running",
    alive: true,
    activity: "active",
    nodeOffline: false,
    waitingSince: null,
    notify: false,
    lastOutputAt: null,
    access: "owner",
  }) as SubshellView;

interface Call {
  method: string;
  url: string;
  body?: string;
}

/**
 * `failPaneAdds`: how many POST …/panes calls answer 500 (the partial-pane
 * failure branch). Serves two subshells so checkbox clicks are real.
 */
function mockFetch(
  opts: {
    failPaneAdds?: number;
    launchable?: boolean;
    failLaunch?: boolean;
    takenWorkspaces?: { id: string; name: string }[];
    /** What `GET /api/subshells` answers; defaults to the two-row roster. */
    subshells?: SubshellView[];
  } = {},
) {
  const calls: Call[] = [];
  let paneFailsLeft = opts.failPaneAdds ?? 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (method === "GET" && url.pathname === "/api/subshells") {
      return new Response(JSON.stringify(opts.subshells ?? [subshell("s1", "One"), subshell("s2", "Two")]), {
        status: 200,
      });
    }
    // Landing on the New half (zero subshells) mounts the launch form, which
    // reads these for its pickers; the `{}` catch-all below crashes them.
    if (method === "GET" && url.pathname === "/api/presets") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.pathname === "/api/plugins") {
      return new Response(
        JSON.stringify({
          plugins: opts.launchable
            ? [{ id: "terminal", name: "Terminal", type: "terminal", installed: true, enabled: true, builtIn: true }]
            : [],
        }),
        { status: 200 },
      );
    }
    if (method === "GET" && url.pathname === "/api/nodes") {
      return new Response(
        JSON.stringify({
          nodes: opts.launchable
            ? [
                {
                  id: "local",
                  name: "Server",
                  kind: "local",
                  status: "online",
                  canLaunch: true,
                  harnesses: [{ harnessId: "terminal", name: "Terminal", installed: true }],
                  capabilities: [],
                  inventoryStale: false,
                },
              ]
            : [],
        }),
        { status: 200 },
      );
    }
    if (method === "GET" && url.pathname === "/api/files/recent") {
      return new Response(JSON.stringify({ paths: [], home: opts.launchable ? "/tmp" : null }), { status: 200 });
    }
    if (method === "GET" && url.pathname === "/api/workspaces") {
      // The dialog reads this to de-dupe its default name; the tests drive it
      // with the `takenWorkspaces` list so a same-minute second create is
      // provably disambiguated rather than 409-ing.
      return new Response(JSON.stringify(opts.takenWorkspaces ?? []), { status: 200 });
    }
    if (method === "POST" && url.pathname === "/api/subshells") {
      return opts.failLaunch
        ? Response.json({ message: "Launch failed" }, { status: 500 })
        : Response.json({ id: "launched" });
    }
    if (method === "POST" && url.pathname === "/api/workspaces") {
      return new Response(JSON.stringify({ id: "ws-new" }), { status: 200 });
    }
    if (method === "POST" && url.pathname.startsWith("/api/workspaces/") && url.pathname.endsWith("/panes")) {
      if (paneFailsLeft > 0) {
        paneFailsLeft -= 1;
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return new Response(JSON.stringify({ id: `pane-${calls.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/**
 * `seedSubshells` caches the list under `SUBSHELLS_QUERY_KEY` before mount,
 * so the read has SETTLED when the dialog opens — the state the root-mounted
 * live feed leaves behind in the app, and what the landing segment is decided
 * from. Omit it for the cold-start path: loading at open, list arriving after.
 */
async function renderDialog(onOpenChange: (open: boolean) => void = () => {}, seedSubshells?: SubshellView[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seedSubshells !== undefined) {
    client.setQueryDefaults(SUBSHELLS_QUERY_KEY, { staleTime: Infinity });
    client.setQueryData(SUBSHELLS_QUERY_KEY, seedSubshells);
  }
  const rootRoute = createRootRoute();
  // Route-component mount (not RouterProvider children — those only render
  // while the router loads; the launch-dialog test carries the same note).
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <NewWorkspaceDialog open onOpenChange={onOpenChange} />,
  });
  const wsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, wsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

afterEach(cleanup);

describe("NewWorkspaceDialog", () => {
  it("Cancel clears the retained dialog's previous selection", async () => {
    const { restore } = mockFetch();
    let closed = false;
    try {
      // Keep the instance mounted and its open prop fixed, so the result
      // demonstrates its own reset rather than a parent's unmount.
      await renderDialog((open) => {
        closed = !open;
      });
      const checkbox = await screen.findByRole("checkbox", { name: /One/ });
      fireEvent.click(checkbox);
      expect(checkbox.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
      expect(closed).toBe(true);
      expect(screen.getByRole("checkbox", { name: /One/ }).getAttribute("aria-checked")).toBe("false");
    } finally {
      restore();
    }
  });

  it("excludes agent-created helpers from existing subshells", async () => {
    const rows = [subshell("human", "Human pane"), { ...subshell("helper", "Agent helper"), crossAgent: true }];
    const { restore } = mockFetch({ subshells: rows });
    try {
      await renderDialog(() => {}, rows);
      expect(await screen.findByRole("checkbox", { name: /Human pane/ })).toBeDefined();
      expect(screen.queryByRole("checkbox", { name: /Agent helper/ }) === null).toBe(true);
    } finally {
      restore();
    }
  });

  it("lands on New when only agent-created helpers exist", async () => {
    const rows = [{ ...subshell("helper", "Agent helper"), crossAgent: true }];
    const { restore } = mockFetch({ subshells: rows });
    try {
      await renderDialog(() => {}, rows);
      expect(screen.getByRole("button", { name: "New subshell" }).getAttribute("aria-pressed")).toBe("true");
    } finally {
      restore();
    }
  });

  it("Create workspace launches the New subshell draft and attaches it before closing", async () => {
    const { calls, restore } = mockFetch({ subshells: [], launchable: true });
    let closed = false;
    try {
      await renderDialog((open) => {
        closed = !open;
      }, []);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Create workspace" }).getAttribute("aria-disabled")).not.toBe("true"),
      );
      fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
      await waitFor(() => expect(closed).toBe(true));
      const posts = calls.filter((c) => c.method === "POST");
      expect(posts.map((c) => c.url)).toEqual(["/api/subshells", "/api/workspaces", "/api/workspaces/ws-new/panes"]);
      expect(JSON.parse(posts[0].body ?? "{}")).toMatchObject({ harnessId: "terminal", workingDir: "/tmp" });
      expect(JSON.parse(posts[2].body ?? "{}")).toEqual({ subshellId: "launched" });
    } finally {
      restore();
    }
  });

  it("a failed launch does not create an empty workspace", async () => {
    const { calls, restore } = mockFetch({ subshells: [], launchable: true, failLaunch: true });
    try {
      await renderDialog(() => {}, []);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Create workspace" }).getAttribute("aria-disabled")).not.toBe("true"),
      );
      fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
      await screen.findByText(/Launch failed/);
      expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/subshells"]);
    } finally {
      restore();
    }
  });

  it("zero selected: creates the workspace alone and closes", async () => {
    const { calls, restore } = mockFetch();
    const openChanges: boolean[] = [];
    try {
      await renderDialog((o: boolean) => openChanges.push(o));
      fireEvent.click(await screen.findByRole("button", { name: /Create workspace/i }));
      await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/workspaces")).toBe(true));
      expect(calls.some((c) => c.url.endsWith("/panes"))).toBe(false);
      // Success closes the dialog — the callback says `false`, then.
      await waitFor(() => expect(openChanges).toContain(false));
    } finally {
      restore();
    }
  });

  it("selects checkboxes and posts a pane for each", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderDialog();
      fireEvent.click(await screen.findByRole("checkbox", { name: /One/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /Two/ }));
      fireEvent.click(screen.getByRole("button", { name: /Create workspace/i }));
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/panes")).length).toBe(2));
      expect(JSON.parse(calls.find((c) => c.url.endsWith("/panes"))?.body ?? "{}")).toEqual({ subshellId: "s1" });
    } finally {
      restore();
    }
  });

  it("partial pane failure: keeps the dialog and offers Enter workspace", async () => {
    const { restore } = mockFetch({ failPaneAdds: 1 });
    try {
      await renderDialog();
      fireEvent.click(await screen.findByRole("checkbox", { name: /One/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /Two/ }));
      fireEvent.click(screen.getByRole("button", { name: /Create workspace/i }));
      expect(await screen.findByText(/but 1 subshell could not be added/i)).toBeDefined();
      expect(screen.getByRole("button", { name: /Enter workspace/i })).toBeDefined();
    } finally {
      restore();
    }
  });

  it("disambiguates a same-minute second create instead of sending a colliding name", async () => {
    // The bug (operator 2026-09-27): the default name is a MINUTE stamp, so two
    // creates in one minute sent the identical name and the second died a 409.
    // `toLocaleString` is pinned so the stamp is a fixed string the create call
    // reproduces — otherwise the test would straddle a minute boundary at random.
    const stamp = "Sep 27, 7:37 AM";
    const timeSpy = spyOn(Date.prototype, "toLocaleString").mockReturnValue(stamp);
    const { calls, restore } = mockFetch({ takenWorkspaces: [{ id: "w1", name: stamp }] });
    try {
      await renderDialog();
      fireEvent.click(await screen.findByRole("button", { name: /Create workspace/i }));
      let post: Call | undefined;
      await waitFor(() => {
        post = calls.find((c) => c.method === "POST" && c.url === "/api/workspaces");
        expect(post).toBeDefined();
      });
      expect(JSON.parse(post?.body ?? "{}").name).toBe(`${stamp} (2)`);
    } finally {
      timeSpy.mockRestore();
      restore();
    }
  });

  it("lands on the New segment when the instance has no subshells yet", async () => {
    // Operator finding 2026-10-20: with zero subshells the dialog opened on
    // "Existing subshells", a tab whose empty state could only be a lie.
    const { restore } = mockFetch({ subshells: [] });
    try {
      await renderDialog(() => {}, []);
      expect(screen.getByRole("button", { name: "New subshell" }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("button", { name: "Existing subshells" }).getAttribute("aria-pressed")).toBe("false");
      // Not just a pressed button: the New half is what's on screen.
      expect(screen.getByRole("button", { name: /Create workspace/ }).getAttribute("aria-disabled")).toBe("true");
    } finally {
      restore();
    }
  });

  it("a zero list arriving after open does not yank the segment off Existing", async () => {
    // The landing is decided at open; a cold read ("unknown" then) keeps
    // "existing", and what settles afterwards must not flip it. The empty
    // state still tells the truth about WHY the tab is empty.
    const { restore } = mockFetch({ subshells: [] });
    try {
      await renderDialog();
      expect(await screen.findByText(/No subshells yet/)).toBeDefined();
      expect(screen.getByRole("button", { name: "Existing subshells" }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("button", { name: "New subshell" }).getAttribute("aria-pressed")).toBe("false");
    } finally {
      restore();
    }
  });
});
