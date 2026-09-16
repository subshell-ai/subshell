import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { InstancePluginRow, PluginImpact } from "@/hooks/use-instance-plugins";
import { PRESETS_QUERY_KEY } from "@/hooks/use-presets";
import { apiFetch } from "@/lib/api";
import { Route } from "@/routes/settings_.plugins";

/**
 * The instance plugins page (spec 2026-09-10 §6, §6.1): catalog installs are
 * one click, a typed package name confirms and says plainly that the code
 * runs on the CONTROL PLANE, disabling is a PATCH that never touches the
 * bytes, and the uninstall dialog fetches the impact before it offers the
 * Keep (default) / Delete choice the shared boolean `confirmAction` cannot
 * express. The admin gate mirrors `settings_.status.tsx`: reads for every
 * authenticated actor, write controls for cookie admins only.
 */

interface RowFixture {
  id: string;
  name: string;
  /** Default true; false puts the row in the one-click catalog region */
  installed?: boolean;
  enabled?: boolean;
  /** Default: true for catalog rows, false for installed ones */
  builtIn?: boolean;
  version?: string;
  broken?: string;
  /** Manifest type — decides which heading the row lands under */
  type?: "agent-harness" | "terminal" | "network";
}

interface PageFixture {
  admin: boolean;
  installed?: RowFixture[];
  catalog?: RowFixture[];
  impact?: PluginImpact;
  /** The first PATCH fails; later ones succeed (the retry-the-row case). */
  failPatchOnce?: boolean;
}

function row(f: RowFixture): InstancePluginRow {
  const installed = f.installed ?? true;
  return {
    id: f.id,
    name: f.name,
    description: "",
    installed,
    enabled: f.enabled ?? true,
    builtIn: f.builtIn ?? !installed,
    ...(f.version ? { version: f.version } : {}),
    ...(f.broken ? { broken: f.broken } : {}),
    ...(f.type ? { type: f.type } : {}),
  };
}

interface Call {
  method: string;
  pathname: string;
  search: string;
  body?: string;
}

/**
 * The `/api/plugins*` table the page talks to, plus `/api/settings/public`
 * for the admin flag. Mutations are recorded rather than applied; the page's
 * invalidation refetches the SAME fixture rows, which is enough to assert
 * what went out on the wire.
 */
function mockServer(fx: PageFixture) {
  const calls: Call[] = [];
  const plugins = [...(fx.installed ?? []).map(row), ...(fx.catalog ?? []).map(row)];
  let failRemaining = fx.failPatchOnce ? 1 : 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, pathname: url.pathname, search: url.search, body: init?.body as string | undefined });
    const json = (obj: unknown) => Promise.resolve(new Response(JSON.stringify(obj)));
    if (url.pathname === "/api/presets" && method === "GET") return json([]);
    if (url.pathname.startsWith("/api/plugins") && method === "PATCH") {
      if (failRemaining > 0) {
        failRemaining--;
        return Promise.resolve(new Response(JSON.stringify({ message: "nope" }), { status: 502 }));
      }
    }
    if (url.pathname === "/api/settings/public") {
      return json({
        allowRegistrations: false,
        emergencyLoginActive: false,
        instanceName: "test",
        appBaseUrl: "http://localhost:3080",
        viewerIsAdmin: fx.admin,
        serverVersion: "1.6.0",
      });
    }
    if (url.pathname === "/api/plugins" && method === "GET") return json({ plugins });
    if (url.pathname === "/api/plugins" && method === "POST") {
      return json(row({ id: "installed", name: "installed" }));
    }
    const patch = /^\/api\/plugins\/([^/]+)$/.exec(url.pathname);
    if (patch && method === "PATCH") {
      const id = patch[1] ?? "unknown";
      return json(row({ id, name: id }));
    }
    if (patch && method === "DELETE") return json({ ok: true, mode: "keep", presetsRemoved: 0 });
    const impact = /^\/api\/plugins\/([^/]+)\/impact$/.exec(url.pathname);
    if (impact && method === "GET") {
      return json(fx.impact ?? { presets: 0, distinctUsers: 0, runningSubshells: 0 });
    }
    return json({});
  }) as typeof fetch;
  const lastBody = (pred: (c: Call) => boolean) => {
    const last = [...calls].reverse().find(pred);
    return last ? JSON.parse(String(last.body)) : undefined;
  };
  return {
    calls,
    restore: () => (globalThis.fetch = original),
    /** The last POST /api/plugins body. */
    posted: () => lastBody((c) => c.method === "POST" && c.pathname === "/api/plugins"),
    /** The last PATCH /api/plugins/:id body. */
    patched: () => lastBody((c) => c.method === "PATCH" && c.pathname.startsWith("/api/plugins/")),
    /** The query of the last DELETE, as an object (`{ mode }`). */
    deletedWith: () => {
      const last = calls.filter((c) => c.method === "DELETE").at(-1);
      return last ? Object.fromEntries(new URLSearchParams(last.search)) : undefined;
    },
  };
}

/**
 * Holds a PRESETS_QUERY_KEY query ACTIVE for the duration of a render, so
 * `invalidateQueries` against it must produce a visible refetch (TanStack
 * only refetches stale keys that have observers). Used by the uninstall test:
 * `mode=delete` sweeps presets for EVERY user, so the uninstall mutation
 * must invalidate this key or the viewer keeps a phantom list until refetch-
 * on-focus.
 */
function PresetsProbe() {
  useQuery({
    queryKey: PRESETS_QUERY_KEY,
    queryFn: () => apiFetch<unknown[]>("/api/presets"),
  });
  return null;
}

function renderPage(probePresets = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Re-parented onto a test root carrying the ConfirmProvider, the same
  // provider __root mounts in production (install-by-name confirms through it).
  const rootRoute = createRootRoute({
    component: () => (
      <ConfirmProvider>
        <Outlet />
        {probePresets && <PresetsProbe />}
      </ConfirmProvider>
    ),
  });
  const pluginsRoute = Route.update({
    id: "/settings_/plugins",
    path: "/settings/plugins",
    getParentRoute: () => rootRoute,
  } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([pluginsRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/plugins"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("instance plugins page", () => {
  it("a catalog install asks nothing", async () => {
    const m = mockServer({ admin: true, catalog: [{ id: "pi", name: "Pi", installed: false }] });
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /install/i }));
      await waitFor(() => expect(m.posted()).toMatchObject({ pluginId: "pi" }));
      // toMatchObject alone would also pass on a body that ADDED a spec: the
      // one-click install is the embedded copy, so the body is exactly that.
      expect(m.posted()).toEqual({ pluginId: "pi" });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("a typed package name confirms, and says it runs on the control plane", async () => {
    const m = mockServer({ admin: true });
    try {
      renderPage();
      const field = await screen.findByLabelText(/install from npm/i);
      fireEvent.change(field, { target: { value: "@acme/plugin-thing" } });
      fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/control plane/i)).toBeDefined();
      fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
      // The id the page cannot know is asserted, not guessed silently: the
      // server refuses a package that declares a different one, by name.
      await waitFor(() => expect(m.posted()).toEqual({ pluginId: "thing", spec: "@acme/plugin-thing" }));
    } finally {
      m.restore();
    }
  });

  it("typing a catalog name is still one click, no confirm", async () => {
    const m = mockServer({ admin: true, catalog: [{ id: "pi", name: "Pi", installed: false }] });
    try {
      renderPage();
      const field = await screen.findByLabelText(/install from npm/i);
      fireEvent.change(field, { target: { value: "@subshell-ai/plugin-pi" } });
      fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
      await waitFor(() => expect(m.posted()).toEqual({ pluginId: "pi" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("an unofficial package named like a built-in is a confirmed spec install, never a silent embedded one", async () => {
    // The claim-conflict case (review I1): `@acme/plugin-pi` is exactly the
    // naming a third party would copy. The page must NOT substitute this
    // build's pi: it asks (control-plane copy) and forwards the SPEC, so the
    // server's own expectId rule is the authority — it refuses a package
    // whose declared id conflicts, by name.
    const m = mockServer({ admin: true, catalog: [{ id: "pi", name: "Pi", installed: false }] });
    try {
      renderPage();
      const field = await screen.findByLabelText(/install from npm/i);
      fireEvent.change(field, { target: { value: "@acme/plugin-pi" } });
      fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/control plane/i)).toBeDefined();
      fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
      // The typed spec survives. A spec-less catalog POST here is the bug.
      await waitFor(() => expect(m.posted()).toEqual({ pluginId: "pi", spec: "@acme/plugin-pi" }));
    } finally {
      m.restore();
    }
  });

  it("disabling a plugin marks it disabled without uninstalling", async () => {
    const m = mockServer({ admin: true, installed: [{ id: "pi", name: "Pi", enabled: true }] });
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("switch", { name: /enabled/i }));
      await waitFor(() => expect(m.patched()).toEqual({ enabled: false }));
      // A PATCH is the whole act: nothing left, nothing deleted.
      expect(m.calls.some((c) => c.method === "DELETE")).toBe(false);
    } finally {
      m.restore();
    }
  });

  it("uninstall shows the blast radius and defaults to keeping presets", async () => {
    const fixture: PageFixture = {
      admin: true,
      installed: [{ id: "acme", name: "Acme" }],
      impact: { presets: 4, distinctUsers: 3, runningSubshells: 1 },
    };
    const m = mockServer(fixture);
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /uninstall/i }));
      expect(await screen.findByText(/4 presets use it, across 3 users/i)).toBeDefined();
      const keep = screen.getByRole("radio", { name: /keep the presets/i }) as HTMLInputElement;
      expect(keep.checked).toBe(true);
      expect(screen.getByText(/running subshells are unaffected/i)).toBeDefined();
      // The dialog's own confirm is the only button named exactly "Uninstall";
      // the row buttons name their plugin.
      fireEvent.click(screen.getByRole("button", { name: /^uninstall$/i }));
      await waitFor(() => expect(m.deletedWith()).toEqual({ mode: "keep" }));
    } finally {
      m.restore();
    }
  });

  it("choosing delete sends mode=delete", async () => {
    const fixture: PageFixture = {
      admin: true,
      installed: [{ id: "acme", name: "Acme" }],
      impact: { presets: 4, distinctUsers: 3, runningSubshells: 1 },
    };
    const m = mockServer(fixture);
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /uninstall/i }));
      await screen.findByText(/4 presets use it, across 3 users/i);
      fireEvent.click(screen.getByRole("radio", { name: /delete the 4 presets permanently/i }));
      fireEvent.click(screen.getByRole("button", { name: /^uninstall$/i }));
      await waitFor(() => expect(m.deletedWith()).toEqual({ mode: "delete" }));
    } finally {
      m.restore();
    }
  });

  it("says the running-subshell promise and the restart consequence together", async () => {
    const fixture: PageFixture = {
      admin: true,
      installed: [{ id: "acme", name: "Acme" }],
      impact: { presets: 4, distinctUsers: 3, runningSubshells: 1 },
    };
    const m = mockServer(fixture);
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /uninstall/i }));
      await screen.findByText(/4 presets use it, across 3 users/i);
      expect(screen.getByText(/restart of one whose preset was deleted will fail/i)).toBeDefined();
    } finally {
      m.restore();
    }
  });

  it("collapses the stakes when nothing uses the plugin", async () => {
    const fixture: PageFixture = {
      admin: true,
      installed: [{ id: "acme", name: "Acme" }],
      impact: { presets: 0, distinctUsers: 0, runningSubshells: 0 },
    };
    const m = mockServer(fixture);
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /uninstall/i }));
      expect(await screen.findByText(/no presets use it/i)).toBeDefined();
      expect(screen.getByRole("radio", { name: /keep the presets/i })).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: /^uninstall$/i }));
      await waitFor(() => expect(m.deletedWith()).toEqual({ mode: "keep" }));
    } finally {
      m.restore();
    }
  });

  it("shows the load failure of a broken plugin, so an absent-looking row explains itself", async () => {
    const fixture: PageFixture = { admin: true, installed: [{ id: "pi", name: "Pi", broken: "missing entry file" }] };
    const m = mockServer(fixture);
    try {
      renderPage();
      expect(await screen.findByText(/missing entry file/i)).toBeDefined();
    } finally {
      m.restore();
    }
  });

  it("a failed toggle says so, and a later success retires the message", async () => {
    const m = mockServer({ admin: true, installed: [{ id: "thing", name: "Thing" }], failPatchOnce: true });
    try {
      renderPage();
      const sw = await screen.findByRole("switch", { name: "Thing enabled" });
      fireEvent.click(sw);
      // First PATCH answers 502: the row must show the failure, not silently
      // snap back to the server's still-unchanged state.
      await screen.findByText(/nope/i);
      fireEvent.click(sw);
      // The retry succeeds — and the stale error must LEAVE. A kept-up
      // failure line under a control that just worked reads as "still
      // broken" and is a lie about the current state.
      await waitFor(() => expect(screen.queryByText(/nope/i)).toBeNull());
    } finally {
      m.restore();
    }
  });

  it("uninstall with mode=delete re-fetches the viewer's presets list", async () => {
    const m = mockServer({ admin: true, installed: [{ id: "thing", name: "Thing" }] });
    try {
      renderPage(true); // presets probe active, so invalidation shows on the wire
      const presetsGets = () => m.calls.filter((c) => c.method === "GET" && c.pathname === "/api/presets").length;
      await screen.findByText("Thing");
      expect(presetsGets()).toBeGreaterThanOrEqual(1);
      fireEvent.click(screen.getByRole("button", { name: "Uninstall Thing" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("radio", { name: /Delete the presets/i }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall" }));
      await waitFor(() => expect(m.deletedWith()).toMatchObject({ mode: "delete" }));
      // The sweep covers EVERY user's presets; a presets list left stale
      // until refetch-on-focus is a phantom.
      await waitFor(() => expect(presetsGets()).toBeGreaterThanOrEqual(2));
    } finally {
      m.restore();
    }
  });

  it("groups the installed rows by what they ARE, once there is more than one kind", async () => {
    const m = mockServer({
      admin: true,
      installed: [
        { id: "claude-code", name: "Claude Code", type: "agent-harness" },
        { id: "terminal", name: "Terminal", type: "terminal" },
        { id: "tailscale", name: "Tailscale", type: "network" },
      ],
    });
    try {
      renderPage();
      expect(await screen.findByRole("heading", { name: "Agents" })).toBeDefined();
      expect(screen.getByRole("heading", { name: "Terminal" })).toBeDefined();
      // The one that earns the grouping: disabling a network is not the same
      // kind of act as disabling an agent, and an undifferentiated list
      // invites the same shrug for both.
      expect(screen.getByRole("heading", { name: "Networks" })).toBeDefined();
    } finally {
      m.restore();
    }
  });

  it("does not head a list that is all one kind", async () => {
    const m = mockServer({ admin: true, installed: [{ id: "pi", name: "Pi", type: "agent-harness" }] });
    try {
      renderPage();
      await screen.findByText("Pi");
      // A heading above the only list names a distinction the reader cannot
      // be confusing anything with.
      expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("disabling a NETWORK asks first and says what it stops", async () => {
    const m = mockServer({ admin: true, installed: [{ id: "tailscale", name: "Tailscale", type: "network" }] });
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("switch", { name: /enabled/i }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Disabling stops publishing this server on Tailscale.")).toBeDefined();
      fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
      await waitFor(() => expect(m.patched()).toEqual({ enabled: false }));
    } finally {
      m.restore();
    }
  });

  it("cancelling that question changes nothing", async () => {
    const m = mockServer({ admin: true, installed: [{ id: "tailscale", name: "Tailscale", type: "network" }] });
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("switch", { name: /enabled/i }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(m.calls.some((c) => c.method === "PATCH")).toBe(false);
    } finally {
      m.restore();
    }
  });

  it("disabling an AGENT still asks nothing", async () => {
    // Every other type is a launch option that stops being offered, and
    // asking about those is the ask nobody reads.
    const m = mockServer({ admin: true, installed: [{ id: "pi", name: "Pi", type: "agent-harness" }] });
    try {
      renderPage();
      fireEvent.click(await screen.findByRole("switch", { name: /enabled/i }));
      await waitFor(() => expect(m.patched()).toEqual({ enabled: false }));
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      m.restore();
    }
  });

  it("a non-admin sees the list and no controls", async () => {
    const m = mockServer({ admin: false, installed: [{ id: "pi", name: "Pi" }] });
    try {
      renderPage();
      expect(await screen.findByText("Pi")).toBeDefined();
      expect(screen.queryByRole("button", { name: /uninstall/i })).toBeNull();
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByLabelText(/install from npm/i)).toBeNull();
      // The READ is open to every authenticated actor; only the writes are admin-only.
      expect(m.calls.some((c) => c.method === "GET" && c.pathname === "/api/plugins")).toBe(true);
    } finally {
      m.restore();
    }
  });
});
