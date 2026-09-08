import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DirectoryPickerInput } from "@/components/directory-picker-input";

/**
 * Renders the field inside a fully controlled parent — every `onChange`
 * (typed or picked) flows straight back in as the new `value`, exactly like
 * the forms that use this component. That round-trip is what the component's
 * typed-path sync has to stay correct against.
 */
function renderField(
  opts: { value?: string; onChange?: (path: string) => void; nodeId?: string; nodeName?: string } = {},
) {
  // retry: 0 so the error state settles on the first failed fetch.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let current = opts.value ?? "/tmp";
  const field = (value: string) => (
    <QueryClientProvider client={client}>
      <DirectoryPickerInput
        id="wd"
        value={value}
        onChange={(p) => {
          opts.onChange?.(p);
          apply(p);
        }}
        nodeId={opts.nodeId}
        nodeName={opts.nodeName}
      />
    </QueryClientProvider>
  );
  function apply(path: string) {
    current = path;
    result.rerender(field(current));
  }
  const result = render(field(current));
  return {
    ...result,
    /** Focuses the input — what opens the panel now. */
    open: () => {
      fireEvent.focus(result.getByRole("textbox"));
    },
    /** Types a new path into the input and applies it like a real parent would. */
    typePath: (path: string) => {
      fireEvent.change(result.getByRole("textbox"), { target: { value: path } });
      apply(path);
    },
  };
}

/** A canned explore body for `path`: one dir entry per name, plus saved rows. */
function exploreBody(
  path: string,
  dirNames: string[],
  recent: { path: string; label: string | null }[] = [],
  favorites: { path: string; label: string | null }[] = [],
) {
  // Mirrors the backend: parent is null only at "/", so a single-segment
  // dir like "/tmp" has "/" as its parent (its only slash is at index 0).
  const idx = path.lastIndexOf("/");
  const parent = path === "/" ? null : idx > 0 ? path.slice(0, idx) : "/";
  return {
    path,
    parent,
    entries: dirNames.map((name) => ({
      name,
      path: `${path === "/" ? "" : path}/${name}`,
      kind: "dir" as const,
    })),
    recent,
    favorites,
  };
}

/**
 * Serves explore bodies per requested `path` query param, keyed by the
 * request URL's path. Unknown paths render as empty folders. `requested`
 * records every path fetched, in order — evidence of *what* was browsed,
 * not just what the panel ended up showing. PATCH /api/files/favorite
 * answers `{ ok: true }` and lands in `favorites` (the calls), so a test can
 * assert the star's wire shape.
 */
function mockExplore(tree: Record<string, unknown>, opts: { nodeCode?: string; nodeStatus?: number } = {}) {
  const requested: string[] = [];
  const requestedNode: (string | null)[] = [];
  const favoriteCalls: { url: string; init?: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/files/favorite") {
      favoriteCalls.push({ url: url.pathname, init });
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }
    const path = url.searchParams.get("path") ?? "";
    requested.push(path);
    requestedNode.push(url.searchParams.get("node"));
    // A `nodeCode` answer models the too-old-node refusal (409 NODE_OUTDATED):
    // a structured body so `ApiError.code` carries the machine code.
    if (opts.nodeCode) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            errId: "t",
            code: opts.nodeCode,
            message: "The subshell app on this node is too old to browse folders there — update it.",
            statusCode: opts.nodeStatus ?? 409,
          }),
          { status: opts.nodeStatus ?? 409 },
        ),
      );
    }
    // A `null` tree entry answers like the backend's 404: structured body,
    // not_found status — what ApiError carries the status on.
    if (tree[path] === null) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ errId: "t", code: "NOT_FOUND", message: "Path does not exist", statusCode: 404 }),
          { status: 404 },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(tree[path] ?? { path, parent: null, entries: [], recent: [], favorites: [] })),
    );
  }) as typeof fetch;
  return {
    requested,
    requestedNode,
    favoriteCalls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Replaces global.fetch for one test; restores the previous value after. */
function mockFetch(impl: (input: unknown, init?: unknown) => Promise<Response> | Response) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("DirectoryPickerInput", () => {
  afterEach(cleanup);

  it("focusing the input opens the panel and shows a loading row while the explore fetch is in flight", () => {
    const restore = mockFetch(() => new Promise<Response>(() => {})); // never resolves
    try {
      renderField();
      fireEvent.focus(screen.getByRole("textbox"));
      // The panel exists immediately — a slow browse must not look like a
      // dead field.
      expect(screen.getByText("Loading…")).toBeDefined();
      // And it is already the panel's final size: every state (loading,
      // error, listing) renders the same fixed-height body, so navigating
      // never resizes the panel.
      expect(screen.getByText("Loading…").className).toContain("h-56");
    } finally {
      restore();
    }
  });

  it("shows an error row when the explore fetch fails", async () => {
    const restore = mockFetch(() => Promise.resolve(new Response("nope", { status: 500 })));
    try {
      renderField();
      fireEvent.focus(screen.getByRole("textbox"));
      await waitFor(() => expect(screen.getByText("Couldn't browse this path.")).toBeDefined());
    } finally {
      restore();
    }
  });

  it("threads the selected node through the explore request; 'local' keeps the param off — byte-identical local browse", async () => {
    const remote = mockExplore({ "/srv": exploreBody("/srv", ["data"]) });
    try {
      renderField({ value: "/srv", nodeId: "node-7", nodeName: "Mac Mini" });
      fireEvent.focus(screen.getByRole("textbox"));
      await screen.findByText("data");
      expect(remote.requested).toEqual(["/srv"]);
      expect(remote.requestedNode).toEqual(["node-7"]);
    } finally {
      remote.restore();
    }
    // The second render needs the first unmounted, or "data" matches twice.
    cleanup();
    const local = mockExplore({ "/srv": exploreBody("/srv", ["data"]) });
    try {
      renderField({ value: "/srv", nodeId: "local" });
      fireEvent.focus(screen.getByRole("textbox"));
      await screen.findByText("data");
      expect(local.requestedNode).toEqual([null]);
    } finally {
      local.restore();
    }
  });

  it("a too-old node names the machine and the remedy — not the generic browse failure", async () => {
    const { restore } = mockExplore({}, { nodeCode: "NODE_OUTDATED" });
    try {
      renderField({ value: "/srv", nodeId: "node-7", nodeName: "Mac Mini" });
      fireEvent.focus(screen.getByRole("textbox"));
      await screen.findByText(/Mac Mini is too old to browse folders there — update it\./);
      expect(screen.queryByText("Couldn't browse this path.")).toBeNull();
      // Neither the path-correction branch nor Start over applies: the path
      // was fine, the AGENT is not.
      expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("drops the favorite star while browsing another machine (favorites are not node-scoped)", async () => {
    const { favoriteCalls, restore } = mockExplore({ "/srv": exploreBody("/srv", ["data"]) });
    try {
      renderField({ value: "/srv", nodeId: "node-7" });
      fireEvent.focus(screen.getByRole("textbox"));
      await screen.findByText("data");
      expect(screen.queryByRole("button", { name: "Favorite /srv/data" })).toBeNull();
      // The row itself is still pickable — only the star is withheld.
      fireEvent.click(screen.getByText("data"));
      expect(favoriteCalls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("clicking a folder sets the input to it and descends without closing the panel", async () => {
    const picks: string[] = [];
    const { requested, restore } = mockExplore({
      "/home": exploreBody("/home", ["projects"]),
      "/home/projects": exploreBody("/home/projects", ["subshell"]),
      "/home/projects/subshell": exploreBody("/home/projects/subshell", ["src"]),
    });
    try {
      const field = renderField({ value: "/home", onChange: (p) => picks.push(p) });
      field.open();
      // Each click is one action: the input gets the folder AND the panel
      // descends into it. Two levels deep, no extra button involved.
      fireEvent.click(await screen.findByText("projects"));
      fireEvent.click(await screen.findByText("subshell"));
      await screen.findByText("src");
      // The listing state uses the same fixed-height body as the loading
      // state above — scrolls internally instead of growing.
      expect(field.container.querySelector(".overflow-y-auto")?.className).toContain("h-56");
      expect(picks).toEqual(["/home/projects", "/home/projects/subshell"]);
      // The first click's typed-sync timer must not yank the panel back to
      // /home/projects after the second click has already descended.
      await new Promise((r) => setTimeout(r, 300));
      expect(screen.queryByText("subshell")).toBeNull();
      // "/home" is fetched once at focus; the descend fetches the others.
      expect(requested.filter((p) => p === "/home/projects")).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("a recent entry selects and browses the panel to it — closing is not part of it", async () => {
    const picks: string[] = [];
    const { requested, restore } = mockExplore({
      "/tmp": exploreBody("/tmp", [], [{ path: "/srv/app", label: "app" }]),
      "/srv/app": exploreBody("/srv/app", ["src"]),
    });
    try {
      renderField({ value: "/tmp", onChange: (p) => picks.push(p) });
      fireEvent.focus(screen.getByRole("textbox"));
      fireEvent.click(await screen.findByText("app"));
      expect(picks).toEqual(["/srv/app"]);
      // The panel followed the selection like any other folder click: its
      // listing now shows /srv/app, and the shortcut stays reachable.
      await screen.findByText("src");
      expect(requested).toContain("/srv/app");
    } finally {
      restore();
    }
  });

  it("favorites render under Recent with a solid star, and select like a recent", async () => {
    const picks: string[] = [];
    const { restore } = mockExplore({
      "/tmp": exploreBody(
        "/tmp",
        [],
        [{ path: "/srv/recent", label: null }],
        [{ path: "/srv/starred", label: "starred repo" }],
      ),
      "/srv/starred": exploreBody("/srv/starred", ["nested"]),
    });
    try {
      renderField({ value: "/tmp", onChange: (p) => picks.push(p) });
      fireEvent.focus(screen.getByRole("textbox"));
      // Both sections exist and Favorites sits under Recent.
      await screen.findByText("starred repo");
      const order = screen.getAllByText(/^(Recent|Favorites)$/).map((n) => n.textContent);
      expect(order).toEqual(["Recent", "Favorites"]);
      // The favorite's star is visible without hovering (it is the un-star
      // affordance) and carries the starred accessible name.
      expect(screen.getByRole("button", { name: "Unfavorite /srv/starred" })).toBeDefined();
      fireEvent.click(screen.getByText("starred repo"));
      expect(picks).toEqual(["/srv/starred"]);
      // Like every other row: select AND browse, panel stays open.
      await screen.findByText("nested");
    } finally {
      restore();
    }
  });

  it("a typed path that does not exist says so and offers a start-over that clears", async () => {
    const picks: string[] = [];
    const { restore } = mockExplore({
      "/tmp": exploreBody("/tmp", ["cache"]),
      "/tmp/ghost": null, // backend 404
    });
    try {
      const { typePath, open } = renderField({ value: "/tmp", onChange: (p) => picks.push(p) });
      open();
      await screen.findByText("cache");
      typePath("/tmp/ghost");
      await screen.findByText(/doesn't exist/);
      // The generic failure message belongs to other errors, not this one.
      expect(screen.queryByText("Couldn't browse this path.")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Start over" }));
      // Typing already flowed to the parent (controlled input); Start over
      // is the second write — the clear.
      expect(picks).toEqual(["/tmp/ghost", ""]);
      // And the panel resumes at home, not on the dead path.
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    } finally {
      restore();
    }
  });

  it("the star on a hovered row PATCHes the favorite without selecting or closing", async () => {
    const { requested, favoriteCalls, restore } = mockExplore({
      "/tmp": exploreBody("/tmp", ["cache"], [{ path: "/srv/known", label: null }], []),
    });
    try {
      renderField({ value: "/tmp" });
      fireEvent.focus(screen.getByRole("textbox"));
      await screen.findByText("cache");
      fireEvent.click(screen.getByRole("button", { name: "Favorite /tmp/cache" }));
      await waitFor(() => expect(favoriteCalls).toHaveLength(1));
      const init = favoriteCalls[0].init as { method: string; body: string };
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body)).toEqual({ path: "/tmp/cache", favorite: true });
      // The star is not a selection: value untouched, panel still open, and
      // the invalidation refetched the current folder.
      await waitFor(() => expect(requested.filter((p) => p === "/tmp").length).toBeGreaterThanOrEqual(2));
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("/tmp");
      expect(screen.queryByText("cache")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("a '..' row moves to the parent folder and selects it, keeping the panel open", async () => {
    const picks: string[] = [];
    const { restore } = mockExplore({
      "/home": exploreBody("/home", ["projects"]),
      "/home/projects": exploreBody("/home/projects", ["subshell"]),
    });
    try {
      renderField({ value: "/home/projects", onChange: (p) => picks.push(p) });
      fireEvent.focus(screen.getByRole("textbox"));
      await screen.findByText("subshell");
      fireEvent.click(screen.getByRole("button", { name: ".." }));
      // Back at /home — its listing renders, and the input followed to the
      // parent like any other selection. /home itself has a parent ("/"),
      // so one more ".." climbs to the root, where the row disappears.
      await screen.findByText("projects");
      fireEvent.click(screen.getByRole("button", { name: ".." }));
      await waitFor(() => expect(screen.queryByRole("button", { name: ".." })).toBeNull());
      expect(picks).toEqual(["/home", "/"]);
    } finally {
      restore();
    }
  });

  it("typing a path moves the open picker to that folder without fetching partial paths", async () => {
    const { requested, restore } = mockExplore({
      "/tmp": exploreBody("/tmp", ["cache"]),
      "/home/theo/projects": exploreBody("/home/theo/projects", ["subshell"]),
    });
    try {
      const { typePath, open } = renderField();
      open();
      await screen.findByText("cache");
      // Two keystrokes in quick succession: only the settled path may be
      // fetched — one explore call per keystroke would hammer the endpoint
      // with paths that only exist once typing pauses.
      typePath("/home/theo");
      typePath("/home/theo/projects");
      // The typed path is the value the moment it is typed; the panel
      // follows it once typing pauses.
      await screen.findByText("subshell");
      expect(requested).toEqual(["/tmp", "/home/theo/projects"]);
    } finally {
      restore();
    }
  });

  it("Escape closes the panel without touching the value", async () => {
    let picked = "";
    const { restore } = mockExplore({ "/tmp": exploreBody("/tmp", []) });
    try {
      renderField({ value: "/tmp", onChange: (p) => (picked = p) });
      fireEvent.focus(screen.getByRole("textbox"));
      // /tmp has a parent, so the ".." row marks an open panel.
      await screen.findByRole("button", { name: ".." });
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("button", { name: ".." })).toBeNull());
      expect(picked).toBe("");
    } finally {
      restore();
    }
  });

  it("a pointerdown outside the field closes the panel", async () => {
    const { restore } = mockExplore({ "/tmp": exploreBody("/tmp", ["cache"]) });
    try {
      renderField({ value: "/tmp" });
      fireEvent.focus(screen.getByRole("textbox"));
      await screen.findByText("cache");
      // A plain Event with the pointerdown type is enough to reach the
      // document listener (happy-dom has no PointerEvent constructor).
      fireEvent(document.body, new Event("pointerdown", { bubbles: true }));
      await waitFor(() => expect(screen.queryByText("cache")).toBeNull());
    } finally {
      restore();
    }
  });
});
