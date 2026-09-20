import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deploymentView } from "@/components/__tests__/helpers/deployment-view";
import { blockedByName, DirectoryPickerInput } from "@/components/directory-picker-input";
import { resetDesktopShellForTests } from "@/lib/desktop";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";
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
            message: "The subshell app on this node is too old to browse folders there. Update it.",
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
