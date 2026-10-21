import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { InfiniteData } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deploymentView } from "@/components/__tests__/helpers/deployment-view";
import { blockedByName, DirectoryPickerInput } from "@/components/directory-picker-input";
import { resetDesktopShellForTests } from "@/lib/desktop";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";
import type { ExploreResult } from "@/types/files";
import type { ServerDeployment } from "@/types/server-deployment";

/**
 * Renders the field inside a fully controlled parent — every `onChange`
 * (typed or picked) flows straight back in as the new `value`, exactly like
 * the forms that use this component. That round-trip is what the component's
 * typed-path sync has to stay correct against.
 */
function renderField(
  opts: {
    value?: string;
    onChange?: (path: string) => void;
    nodeId?: string;
    nodeName?: string;
    clearOption?: string;
    /** Seeds the admin deployment view the picker reads from cache, never fetches. */
    deployment?: ServerDeployment;
  } = {},
) {
  // retry: 0 so the error state settles on the first failed fetch.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (opts.deployment) client.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, opts.deployment);
  let current = opts.value ?? "/tmp";
  let node = opts.nodeId;
  const field = (value: string) => (
    <QueryClientProvider client={client}>
      <DirectoryPickerInput
        id="wd"
        value={value}
        onChange={(p) => {
          opts.onChange?.(p);
          apply(p);
        }}
        placeholder={opts.clearOption ?? "/home/you/my-project"}
        clearOption={opts.clearOption}
        nodeId={node}
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
    /** The test's own QueryClient, for asserting cache state directly (the
     *  star patch's scoping is a cache fact, not a visible one). */
    client,
    /** Focuses the input — what opens the panel now. */
    open: () => {
      fireEvent.focus(result.getByRole("textbox"));
    },
    /** Switches the machine prop the way the launch form's Machine pick does. */
    setNode: (nodeId: string) => {
      node = nodeId;
      result.rerender(field(current));
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
 * not just what the panel ended up showing. `urls` records every full
 * request (pathname + search) so a paging test can assert the exact cursor
 * that rode each request. `opts.pages` maps a cursor VALUE to the body that
 * answers it, which is how the paged tests hang their second pages;
 * `opts.failCursors` answers those cursors with a 500 instead, which is how
 * a test plants a failure in the MIDDLE of a walk. PATCH
 * /api/files/favorite answers `{ ok: true }` and lands in `favoriteCalls`
 * (the calls), so a test can assert the star's wire shape.
 */
function mockExplore(
  tree: Record<string, unknown>,
  opts: {
    nodeCode?: string;
    nodeStatus?: number;
    pages?: Record<string, unknown>;
    failCursors?: string[];
  } = {},
) {
  const requested: string[] = [];
  const requestedNode: (string | null)[] = [];
  const urls: string[] = [];
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
    urls.push(`${url.pathname}${url.search}`);
    // A `nodeCode` answer models the too-old-node refusal (409 NODE_OUTDATED):
    // a structured body so `ApiError.code` carries the machine code.
    if (opts.nodeCode) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            errId: "t",
            code: opts.nodeCode,
            message: "The subshell app on this node is too old to browse folders there. Update it.",
            statusCode: opts.nodeStatus ?? 409,
          }),
          { status: opts.nodeStatus ?? 409 },
        ),
      );
    }
    // A `failCursors` entry: the page fetch that fails mid-walk, which the
    // picker must stop on instead of looping the dead endpoint.
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && opts.failCursors?.includes(cursor)) {
      return Promise.resolve(new Response("nope", { status: 500 }));
    }
    // A paged follow-up: the cursor VALUE keys its canned page, answering
    // whatever cursor string the client carried back.
    if (cursor !== null && opts.pages && cursor in opts.pages) {
      return Promise.resolve(new Response(JSON.stringify(opts.pages[cursor])));
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
    urls,
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

  // The windowed folder list sizes its window from the scroller's
  // clientHeight, and happy-dom has no layout engine to fill it in: every
  // element answers 0, which the virtualizer reads as an invisible viewport
  // and renders NO rows for (a zero-height outer size short-circuits the
  // range to empty, so every listing test would assert against a DOM with
  // nothing in it). Give every element a laid-out size for each test and
  // restore the prototype getters after, so no other file inherits the
  // fiction. 224px is what `h-56` is in a real browser; the rows themselves
  // are sized from the component's fixed row-height constant, not measured,
  // so the scroller's viewport is the only number that matters here.
  let restoreViewport: () => void = () => {};
  beforeEach(() => {
    const proto = HTMLElement.prototype;
    const widthDesc = Object.getOwnPropertyDescriptor(proto, "clientWidth");
    const heightDesc = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 400 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 224 });
    restoreViewport = () => {
      if (widthDesc) Object.defineProperty(proto, "clientWidth", widthDesc);
      if (heightDesc) Object.defineProperty(proto, "clientHeight", heightDesc);
    };
  });
  afterEach(() => restoreViewport());

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

  describe("clearOption (the preset editor's empty-is-a-choice row)", () => {
    it("leads the panel with the label while a path is held; clicking clears the field and closes the panel", async () => {
      const m = mockExplore({ "/srv/app": exploreBody("/srv/app", ["src"]) });
      try {
        const changes: string[] = [];
        renderField({ value: "/srv/app", clearOption: "Decide at launch", onChange: (p) => changes.push(p) });
        fireEvent.focus(screen.getByRole("textbox"));
        const row = await screen.findByRole("button", { name: "Decide at launch" });
        // FIRST row: before anything the browse lists.
        const listing = row.parentElement as HTMLElement;
        expect(listing.firstElementChild).toBe(row);
        fireEvent.click(row);
        expect(changes).toEqual([""]);
        expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
        // The pick is complete: the panel closes the way a select's empty
        // item closes it (unlike Start over, which keeps browsing).
        expect(screen.queryByRole("button", { name: "Decide at launch" })).toBeNull();
        await waitFor(() => expect(screen.queryByText("src")).toBeNull());
      } finally {
        m.restore();
      }
    });

    it("absent while the field is empty (the placeholder already reads the choice) and when the caller passes no label", async () => {
      const m = mockExplore({ "/srv": exploreBody("/srv", ["data"]) });
      try {
        renderField({ value: "", clearOption: "Decide at launch" });
        fireEvent.focus(screen.getByRole("textbox"));
        // An empty field browses from home; the panel has answered.
        await waitFor(() => expect(m.requested.length).toBeGreaterThan(0));
        expect(screen.queryByRole("button", { name: "Decide at launch" })).toBeNull();
        cleanup();
        renderField({ value: "/srv" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByText("data");
        expect(screen.queryByText("Decide at launch")).toBeNull();
      } finally {
        m.restore();
      }
    });
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
      await screen.findByText(/Mac Mini is too old to browse folders there\. Update it\./);
      expect(screen.queryByText("Couldn't browse this path.")).toBeNull();
      // Neither the path-correction branch nor Start over applies: the path
      // was fine, the AGENT is not.
      expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("stars the machine being browsed: the star is offered on a node's rows and the PATCH names it", async () => {
    // The old rule HID the star remotely because favorites had no node
    // column — a node path starred there was a dead click in every later
    // local panel. 0034 scoped favorites per machine and the defect is gone
    // with it; what is pinned here is that the wire names the machine.
    const { favoriteCalls, restore } = mockExplore({ "/srv": exploreBody("/srv", ["data"]) });
    try {
      const h = renderField({ value: "/srv", nodeId: "node-7" });
      h.open();
      await screen.findByText("data");
      fireEvent.click(screen.getByRole("button", { name: "Favorite /srv/data" }));
      await waitFor(() => expect(favoriteCalls).toHaveLength(1));
      const body = JSON.parse(String((favoriteCalls[0].init as RequestInit).body));
      expect(body).toEqual({ path: "/srv/data", favorite: true, node: "node-7" });
      // The row is still pickable beside the star, as always.
      fireEvent.click(screen.getByText("data"));
    } finally {
      restore();
    }
  });

  it("the local star keeps the pre-scoping wire — no node param at all", async () => {
    const { favoriteCalls, restore } = mockExplore({ "/srv": exploreBody("/srv", ["data"]) });
    try {
      const h = renderField({ value: "/srv" });
      h.open();
      await screen.findByText("data");
      fireEvent.click(screen.getByRole("button", { name: "Favorite /srv/data" }));
      await waitFor(() => expect(favoriteCalls).toHaveLength(1));
      expect(JSON.parse(String((favoriteCalls[0].init as RequestInit).body))).toEqual({
        path: "/srv/data",
        favorite: true,
      });
    } finally {
      restore();
    }
  });

  // Favorites are per-machine since migration 0034 and the explore key names
  // the machine, so the in-place star patch must reach ONLY the browsed
  // machine's cached listings. A bare `["explore"]` prefix match let a star
  // on one machine rewrite another's cached panel.
  it("a star on a node's listing patches that node's cache and leaves the local listing's alone", async () => {
    const { favoriteCalls, restore } = mockExplore({ "/srv": exploreBody("/srv", ["data"]) });
    try {
      const h = renderField({ value: "/srv", nodeId: "node-7" });
      h.open();
      await screen.findByText("data");
      // A cached LOCAL listing of the same path, as an earlier local browse left it.
      const localListing: InfiniteData<ExploreResult> = {
        pageParams: [""],
        pages: [exploreBody("/srv", ["data"])],
      };
      h.client.setQueryData(["explore", "/srv"], localListing);
      fireEvent.click(screen.getByRole("button", { name: "Favorite /srv/data" }));
      await waitFor(() => expect(favoriteCalls).toHaveLength(1));
      // The browsed machine's listing gained the favorite...
      const remote = h.client.getQueryData<InfiniteData<ExploreResult>>(["explore", "node-7", "/srv"]);
      expect(remote?.pages[0]?.favorites.map((f) => f.path)).toEqual(["/srv/data"]);
      // ...and the local cache is untouched, the very same object.
      expect(h.client.getQueryData<InfiniteData<ExploreResult>>(["explore", "/srv"])).toBe(localListing);
    } finally {
      restore();
    }
  });

  it("a local star patches the local listing and leaves another node's cached listing alone", async () => {
    const { favoriteCalls, restore } = mockExplore({ "/srv": exploreBody("/srv", ["data"]) });
    try {
      const h = renderField({ value: "/srv" });
      h.open();
      await screen.findByText("data");
      const remoteListing: InfiniteData<ExploreResult> = {
        pageParams: [""],
        pages: [exploreBody("/srv", ["data"])],
      };
      h.client.setQueryData(["explore", "node-7", "/srv"], remoteListing);
      fireEvent.click(screen.getByRole("button", { name: "Favorite /srv/data" }));
      await waitFor(() => expect(favoriteCalls).toHaveLength(1));
      const local = h.client.getQueryData<InfiniteData<ExploreResult>>(["explore", "/srv"]);
      expect(local?.pages[0]?.favorites.map((f) => f.path)).toEqual(["/srv/data"]);
      expect(h.client.getQueryData<InfiniteData<ExploreResult>>(["explore", "node-7", "/srv"])).toBe(remoteListing);
    } finally {
      restore();
    }
  });

  it("switching machines while the panel is open re-anchors it to the new machine's home", async () => {
    // The folder on screen belongs to the filesystem the user just switched
    // AWAY from; "the listing" means nothing on the new machine. The panel
    // goes home and the node-keyed query fetches what is actually there —
    // the refresh the form's path-clear also reaches, guaranteed here for
    // any caller.
    const { requested, requestedNode, restore } = mockExplore({
      "/srv": exploreBody("/srv", ["data"]),
      "~": exploreBody("/home/nodeuser", ["projects"]),
    });
    try {
      const h = renderField({ value: "/srv", nodeId: "node-7" });
      h.open();
      await screen.findByText("data");
      expect(requested).toContain("/srv");
      h.setNode("node-8");
      // The panel asks the NEW machine for `~` — home on both transports —
      // rather than re-walking the old one's folder there.
      await waitFor(() => expect(requested).toContain("~"));
      expect(requestedNode.at(-1)).toBe("node-8");
      await waitFor(() => expect(screen.getAllByText("projects").length).toBeGreaterThan(0));
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

  it("a huge folder renders only a bounded window of rows, and a visible row still picks", async () => {
    // The operator's freeze: `/tmp` answered 31k directories in 86 ms, and
    // committing every row (two buttons each) in one React pass blocked the
    // main thread before the listing ever painted. The committed row count
    // must stay small no matter how many entries arrive, and the far end of
    // the listing must not be in the DOM at all.
    const names = Array.from({ length: 5000 }, (_, i) => `dir-${i}`);
    const picks: string[] = [];
    const { restore } = mockExplore({ "/tmp": exploreBody("/tmp", names) });
    try {
      renderField({ value: "/tmp", onChange: (p) => picks.push(p) });
      fireEvent.focus(screen.getByRole("textbox"));
      await screen.findByTitle("Open dir-0");
      const rows = screen.getAllByTitle(/^Open dir-/);
      // Bounded well below the entry count, and the last directory is not
      // there: this is what used to be 5,000 committed rows.
      expect(rows.length).toBeLessThan(150);
      expect(screen.queryByTitle("Open dir-4999") === null).toBe(true);
      // A row in the window behaves exactly like the old ordinary rows:
      // one click selects the path and the panel descends.
      fireEvent.click(screen.getByTitle("Open dir-0"));
      expect(picks).toEqual(["/tmp/dir-0"]);
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("/tmp/dir-0");
    } finally {
      restore();
    }
  });

  it("a small listing still renders every row in full", async () => {
    // Windowing is for huge folders only: with a few directories every row
    // must be present, exactly as before.
    const { restore } = mockExplore({ "/tmp": exploreBody("/tmp", ["alpha", "beta", "gamma"]) });
    try {
      renderField({ value: "/tmp" });
      fireEvent.focus(screen.getByRole("textbox"));
      await screen.findByTitle("Open alpha");
      expect(screen.getAllByTitle(/^Open /)).toHaveLength(3);
      expect(screen.getByTitle("Open gamma")).toBeDefined();
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
      // The star is not a selection: value untouched, panel still open. And
      // the walk is NOT re-queried: the star patches the cached listing in
      // place (the Favorites section gains the path) rather than
      // invalidating, which under the cursor walk would refetch every page
      // the walk has loaded just to flip one star.
      await screen.findByText("/tmp/cache");
      expect(screen.getAllByText("Favorites")).toHaveLength(1);
      expect(requested.filter((p) => p === "/tmp")).toHaveLength(1);
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

  /**
   * macOS asks per protected folder the first time one is listed, and a
   * decline makes the read throw forever after. The server flags the LISTING
   * (spec 2026-09-14 §5.3) — an empty `entries` with no flag is a folder that
   * genuinely holds nothing, and rendering the refusal as that would tell the
   * person their projects had vanished.
   */
  describe("a folder macOS refuses", () => {
    /** An explore body for a blocked listing: no entries, flag set. */
    function blockedBody(path: string) {
      return { ...exploreBody(path, []), blocked: "permission" as const };
    }

    // The macOS wording is earned only where this page KNOWS the server is on
    // a Mac: inside Subshell Server's own shell on macOS. The server flags
    // EACCES as well as EPERM on every platform, so from a browser the same
    // answer may be plain unix modes on a Linux host (review, 2026-09-14).
    const nav = navigator as unknown as Record<string, unknown>;
    let previousUA: PropertyDescriptor | undefined;
    function onMacShell() {
      previousUA ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
      Object.defineProperty(nav, "userAgent", {
        value: "Mozilla/5.0 SubshellDesktop/1.0.0 (macos; p=1)",
        configurable: true,
        writable: true,
      });
      resetDesktopShellForTests();
    }
    afterEach(() => {
      if (previousUA) Object.defineProperty(nav, "userAgent", previousUA);
      else delete nav.userAgent;
      previousUA = undefined;
      resetDesktopShellForTests();
    });

    it("in a browser, says the folder was refused without naming an OS it cannot see", async () => {
      const { restore } = mockExplore({ "/srv/ada/Desktop": blockedBody("/srv/ada/Desktop") });
      try {
        renderField({ value: "/srv/ada/Desktop" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByText("Not allowed to read this folder");
        expect(screen.queryByText(/macOS/)).toBeNull();
      } finally {
        restore();
      }
    });

    it("says Blocked by macOS instead of showing it as empty", async () => {
      onMacShell();
      const { restore } = mockExplore({ "/Users/ada/Desktop": blockedBody("/Users/ada/Desktop") });
      try {
        renderField({ value: "/Users/ada/Desktop" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByText("Blocked by macOS");
      } finally {
        restore();
      }
    });

    it("names subshell-server, the binary the prompt named, when the deployment is unknown", async () => {
      onMacShell();
      const { restore } = mockExplore({ "/Users/ada/Desktop": blockedBody("/Users/ada/Desktop") });
      try {
        renderField({ value: "/Users/ada/Desktop" });
        fireEvent.focus(screen.getByRole("textbox"));
        // `GET /api/admin/server` is admin-only and is never fetched from
        // here, so most viewers land on this fallback.
        await screen.findByText(/macOS is not letting subshell-server read this folder\./);
      } finally {
        restore();
      }
    });

    it("names the APP instead when the app supervises the server", () => {
      onMacShell();
      // The prompt names whoever asked: under the launchd service that is the
      // binary, under "runs with this app" it is Subshell Server. Naming the
      // wrong one sends a person looking for a row that is not in the list.
      const asApp = { service: { manager: "app", installed: false } } as unknown as ServerDeployment;
      const asService = { service: { manager: "launchd", installed: true } } as unknown as ServerDeployment;
      expect(blockedByName(asApp)).toBe("Subshell Server");
      expect(blockedByName(asService)).toBe("subshell-server");
      expect(blockedByName(undefined)).toBe("subshell-server");
    });

    // The shell is not the only thing that knows. An admin reading this from a
    // browser has the deployment view in cache, and it says which OS the
    // server runs — which is the reading most of these refusals actually get
    // (review, 2026-09-14).
    it("names macOS from the cached deployment view, with no shell involved", async () => {
      const { restore } = mockExplore({ "/Users/ada/Desktop": blockedBody("/Users/ada/Desktop") });
      try {
        renderField({ value: "/Users/ada/Desktop", deployment: { ...deploymentView(), platform: "darwin" } });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByText("Blocked by macOS");
      } finally {
        restore();
      }
    });

    it("keeps its mouth shut when the cached deployment says the server is on Linux", async () => {
      const { restore } = mockExplore({ "/srv/ada/Desktop": blockedBody("/srv/ada/Desktop") });
      try {
        renderField({ value: "/srv/ada/Desktop", deployment: { ...deploymentView(), platform: "linux" } });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByText("Not allowed to read this folder");
        expect(screen.queryByText(/macOS/)).toBeNull();
      } finally {
        restore();
      }
    });

    // Both signals describe the control plane, and a node's filesystem is a
    // different machine's — so neither may speak for it.
    it("says nothing about macOS while browsing another machine", async () => {
      onMacShell();
      const { restore } = mockExplore({ "/srv/data": blockedBody("/srv/data") });
      try {
        renderField({
          value: "/srv/data",
          nodeId: "node-7",
          nodeName: "Build box",
          deployment: { ...deploymentView(), platform: "darwin" },
        });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByText("Not allowed to read this folder");
        expect(screen.queryByText(/macOS/)).toBeNull();
      } finally {
        restore();
      }
    });

    it("an empty folder is still just an empty folder — no notice", async () => {
      const { restore } = mockExplore({ "/tmp/empty": exploreBody("/tmp/empty", []) });
      try {
        renderField({ value: "/tmp/empty" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByRole("button", { name: ".." });
        expect(screen.queryByText("Blocked by macOS")).toBeNull();
      } finally {
        restore();
      }
    });
  });

  // The three dead ends that used to trap the user in the panel (mac-builder,
  // 2026-09-30): the generic browse failure had no escape, and the blocked
  // states replaced the whole body, discarding the saved shortcuts the server
  // still ships for exactly this recovery.
  describe("blocked / error recovery affordances (2026-09-30)", () => {
    it("a timed-out folder offers Go up + Start over", async () => {
      const { restore } = mockExplore({
        "/mnt/nas": { ...exploreBody("/mnt/nas", []), blocked: "timeout" as const },
      });
      try {
        renderField({ value: "/mnt/nas" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByText(/took too long to read/);
        expect(screen.getByRole("button", { name: "Go up one level" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Start over" })).toBeDefined();
      } finally {
        restore();
      }
    });

    it("a blocked folder still lists the favourites — the escape that needs no read", async () => {
      // The whole point of M1: a blocked home is survivable because a starred
      // path is a DIFFERENT path. The server ships favourites/recents on the
      // blocked response; the panel must show them, not a message alone.
      const { restore } = mockExplore({
        "/Users/ada/Desktop": {
          ...exploreBody("/Users/ada/Desktop", []),
          blocked: "permission" as const,
          favorites: [{ path: "/srv/keep", label: null }],
        },
      });
      try {
        const picks: string[] = [];
        renderField({ value: "/Users/ada/Desktop", onChange: (p) => picks.push(p) });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByText("Not allowed to read this folder");
        const fav = await screen.findByText("/srv/keep");
        // Clicking it browses away from the dead folder.
        fireEvent.click(fav);
        expect(picks).toEqual(["/srv/keep"]);
      } finally {
        restore();
      }
    });

    it("a generic browse failure offers a working Start over", async () => {
      const picks: string[] = [];
      const restore = mockFetch(() => Promise.resolve(new Response("nope", { status: 500 })));
      try {
        renderField({ value: "/srv/dead", onChange: (p) => picks.push(p) });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByText("Couldn't browse this path.");
        fireEvent.click(screen.getByRole("button", { name: "Start over" }));
        expect(picks).toContain("");
        expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
      } finally {
        restore();
      }
    });
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

  // The server pages LOCAL browses (200 entries per page) and the picker
  // walks the cursors when the listing's tail comes into view. happy-dom has
  // no scroll, so these tests drive the trigger the same way a small folder
  // does in a real browser: a first page whose whole loaded listing sits
  // inside the virtualizer's window.
  describe("paged local listings", () => {
    it("walks the cursor: the follow-up request carries it verbatim and page 2's rows render after page 1's", async () => {
      // The cursor is opaque and needs encoding ("c 1" travels as c%201),
      // which is exactly what the verbatim round trip must survive.
      const page1 = { ...exploreBody("/big", ["aa", "bb"]), nextCursor: "c 1" };
      const page2 = exploreBody("/big", ["cc", "dd"]);
      const { urls, restore } = mockExplore({ "/big": page1 }, { pages: { "c 1": page2 } });
      try {
        renderField({ value: "/big" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByTitle("Open cc");
        // Exactly one follow-up request, and it names the cursor verbatim:
        // percent-encoded on the wire, decoding back to the same value.
        const followups = urls.filter((u) => u.includes("cursor="));
        expect(followups).toHaveLength(1);
        const second = new URL(followups[0], "http://localhost");
        expect(second.pathname).toBe("/api/files/explore");
        expect(second.searchParams.get("path")).toBe("/big");
        expect(second.searchParams.get("cursor")).toBe("c 1");
        expect(second.search).toContain("cursor=c%201");
        // One continuous listing: page 2's folders follow page 1's.
        expect(screen.getAllByTitle(/^Open /).map((n) => n.getAttribute("title"))).toEqual([
          "Open aa",
          "Open bb",
          "Open cc",
          "Open dd",
        ]);
        // Page 2 names no cursor, so the walk stops there: two requests total.
        expect(urls).toHaveLength(2);
      } finally {
        restore();
      }
    });

    it("a page of pure files pages on anyway: the tail counts folders, not raw entries", async () => {
      // A page carries dirs AND files (the server pages the raw sorted
      // listing), so page 2 here adds ZERO rows to the one-folder listing:
      // the trigger must stay true through it rather than stall waiting for
      // rows that never arrived.
      const page1 = { ...exploreBody("/mixed", ["docs"]), nextCursor: "n2" };
      const filesOnly = {
        path: "/mixed",
        parent: "/",
        entries: [
          { name: "a.txt", path: "/mixed/a.txt", kind: "file" },
          { name: "b.txt", path: "/mixed/b.txt", kind: "file" },
        ],
        recent: [],
        favorites: [],
        nextCursor: "n3",
      };
      const page3 = exploreBody("/mixed", ["work"]);
      const { urls, restore } = mockExplore({ "/mixed": page1 }, { pages: { n2: filesOnly, n3: page3 } });
      try {
        renderField({ value: "/mixed" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByTitle("Open work");
        expect(urls.filter((u) => u.includes("cursor=n2"))).toHaveLength(1);
      } finally {
        restore();
      }
    });

    it("a first page with no folders at all stops the walk: an empty virtualizer cannot page", async () => {
      // The node_modules shape: a files-only directory whose every page sits
      // "inside the margin" forever, so walking it would fire hundreds of
      // requests to render nothing. Page 1 still arrives (the query fetches
      // it on mount, not through the predicate); a folder sorting past this
      // first page needs a typed path, which beats the silent full-chain walk.
      const filesOnly = {
        path: "/files",
        parent: "/",
        entries: [{ name: "a.txt", path: "/files/a.txt", kind: "file" }],
        recent: [],
        favorites: [],
        nextCursor: "c2",
      };
      const { urls, restore } = mockExplore(
        { "/files": filesOnly },
        { pages: { c2: exploreBody("/files", ["late-dir"]) } },
      );
      try {
        renderField({ value: "/files" });
        fireEvent.focus(screen.getByRole("textbox"));
        await waitFor(() => expect(urls).toHaveLength(1));
        await new Promise((r) => setTimeout(r, 100));
        expect(urls).toHaveLength(1);
        expect(screen.queryByTitle("Open late-dir") === null).toBe(true);
      } finally {
        restore();
      }
    });

    it("stops walking once the cursor runs out, even with every row in view", async () => {
      const { urls, restore } = mockExplore({ "/small": exploreBody("/small", ["one", "two"]) });
      try {
        renderField({ value: "/small" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByTitle("Open two");
        // Both rows fit the window, the same state that walks a NON-exhausted
        // listing; with no cursor to spend the walk must not ask again.
        await new Promise((r) => setTimeout(r, 50));
        expect(urls).toHaveLength(1);
        expect(urls[0].includes("cursor=")).toBe(false);
      } finally {
        restore();
      }
    });

    it("a capped remote listing says so once, below the rows", async () => {
      const capped = { ...exploreBody("/capped", ["a1", "a2"]), truncated: true };
      const { restore } = mockExplore({ "/capped": capped });
      try {
        renderField({ value: "/capped" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByTitle("Open a1");
        expect(screen.getAllByText("The listing stops at 1,000 folders, so some may be missing.")).toHaveLength(1);
      } finally {
        restore();
      }
    });

    it("an uncapped listing says nothing about a cap", async () => {
      const { restore } = mockExplore({ "/full": exploreBody("/full", ["one"]) });
      try {
        renderField({ value: "/full" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByTitle("Open one");
        expect(screen.queryByText("The listing stops at 1,000 folders, so some may be missing.") === null).toBe(true);
      } finally {
        restore();
      }
    });

    it("Recent and Favorites render once across paged loads: page 1 is the only shortcut source", async () => {
      // The server rides recent/favorites on EVERY page (each must stand as a
      // usable answer). Pages 2 and 3 carry the same arrays, so a reader that
      // took them per page would draw the sections again per cursor.
      const recent = [{ path: "/srv/app", label: "app" }];
      const favorites = [{ path: "/srv/keep", label: null }];
      const page1 = { ...exploreBody("/deep", ["aa"], recent, favorites), nextCursor: "k2" };
      const page2 = { ...exploreBody("/deep", ["bb"], recent, favorites), nextCursor: "k3" };
      const page3 = exploreBody("/deep", ["cc"], recent, favorites);
      const { urls, restore } = mockExplore({ "/deep": page1 }, { pages: { k2: page2, k3: page3 } });
      try {
        renderField({ value: "/deep" });
        fireEvent.focus(screen.getByRole("textbox"));
        // The chain walks on to exhaustion: 3 pages, one set of sections.
        await screen.findByTitle("Open cc");
        expect(urls).toHaveLength(3);
        expect(screen.getAllByText("app")).toHaveLength(1);
        expect(screen.getAllByText("/srv/keep")).toHaveLength(1);
        expect(screen.getAllByText("Recent")).toHaveLength(1);
        expect(screen.getAllByText("Favorites")).toHaveLength(1);
      } finally {
        restore();
      }
    });

    it("one path landing in two pages (the server re-scans per request) renders one row", async () => {
      // A file added or removed between the two page fetches shifts the raw
      // offsets, so the same entry can arrive twice. Row keys are paths: a
      // second copy would be a duplicate key and a doubled folder row.
      const page1 = { ...exploreBody("/shift", ["a"]), nextCursor: "c2" };
      const page2 = exploreBody("/shift", ["a", "b"]);
      const { urls, restore } = mockExplore({ "/shift": page1 }, { pages: { c2: page2 } });
      try {
        renderField({ value: "/shift" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByTitle("Open b");
        expect(screen.getAllByTitle("Open a")).toHaveLength(1);
        expect(screen.getAllByTitle(/^Open /).map((n) => n.getAttribute("title"))).toEqual(["Open a", "Open b"]);
        expect(urls).toHaveLength(2);
      } finally {
        restore();
      }
    });

    // "Data first, error second": a page-1 failure has nothing to keep and
    // shows the error UI; a mid-walk failure has a fully usable listing in
    // cache and must neither replace it nor keep asking.
    it("a failed first page shows the error UI: there is no listing to keep", async () => {
      const { restore } = mockExplore({ "/gone": null });
      try {
        renderField({ value: "/gone" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByText(/doesn't exist/);
      } finally {
        restore();
      }
    });

    it("a failed page keeps the walked listing on screen and stops the walk", async () => {
      // The folder listed fine, so the browse-failure message must not cover
      // it. And the walk STOPS on the failure: the query's error is sticky
      // until some fetch succeeds and this panel forces none, so a predicate
      // that ignored it would re-fire on every flag flip and hammer the dead
      // endpoint at network speed.
      const page1 = { ...exploreBody("/big", ["aa", "bb"]), nextCursor: "boom" };
      const { urls, restore } = mockExplore({ "/big": page1 }, { failCursors: ["boom"] });
      try {
        renderField({ value: "/big" });
        fireEvent.focus(screen.getByRole("textbox"));
        await screen.findByTitle("Open aa");
        await waitFor(() => expect(urls.filter((u) => u.includes("cursor=boom"))).toHaveLength(1));
        // The listing is still the panel: no full-panel error over it.
        expect(screen.queryByText("Couldn't browse this path.")).toBeNull();
        expect(screen.getByTitle("Open bb")).toBeDefined();
        // Across a settled wait: exactly page 1 plus the one failed page.
        await new Promise((r) => setTimeout(r, 150));
        expect(urls).toHaveLength(2);
      } finally {
        restore();
      }
    });
  });
});
