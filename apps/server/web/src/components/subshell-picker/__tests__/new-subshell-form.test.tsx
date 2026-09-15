import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  emptyNewSubshellForm,
  NewSubshellForm,
  type NewSubshellFormValue,
} from "@/components/subshell-picker/new-subshell-form";

/**
 * The pre-fill and scoping contract of the shared launch form. The
 * agent/preset grid and the form's defaults live in the sibling suite under
 * components/__tests__ — this file owns the working-directory defaults.
 *
 * `mockEndpoints` serves every endpoint the form reads; recentPaths is what
 * varies. The node list answers with a healthy `local` row on purpose: the
 * directory pre-fill deliberately will not ARM until the node query has
 * settled (review round 2 — arming on the mount default's scope while the
 * list is in flight could strand a directory from a node the pick later
 * leaves, with a one-way flag and no way to re-arm). The real node list also
 * means a loaded-zero agent list fires the form's honest-hint branch,
 * which renders a `<Link>` — hence the memory-router wrapper on every
 * render here.
 */
function mockEndpoints(paths: { path: string; label: string | null }[]) {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/files/recent")) {
      return Promise.resolve(new Response(JSON.stringify({ paths, home: null })));
    }
    if (url.includes("/api/nodes")) {
      const local = {
        id: "local",
        name: "Server",
        kind: "local",
        os: null,
        arch: null,
        hostname: null,
        status: "online",
        lastSeenAt: null,
        agentVersion: null,
        protocolVersion: null,
        access: "owner",
        canManage: true,
        canLaunch: true,
        capabilities: [],
        harnesses: [],
        inventoryStale: false,
      };
      return Promise.resolve(new Response(JSON.stringify({ nodes: [local] })));
    }
    if (url.includes("/api/plugins")) {
      return Promise.resolve(new Response(JSON.stringify({ plugins: [] })));
    }
    return Promise.resolve(new Response(JSON.stringify([]))); // /api/presets, /api/subshells
  }) as typeof fetch;
  const restore = (() => {
    globalThis.fetch = original;
  }) as (() => void) & { urls: string[] };
  restore.urls = urls;
  return restore;
}

/** Flush pending query/effect updates inside act() (50 ms is generous for
 *  Promise.resolve-backed mocks; keeps "not wrapped in act" out of the log). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/** A controlled parent like /new and the dialog. */
async function renderForm(initial: NewSubshellFormValue) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [value, setValue] = useState(initial);
    return <NewSubshellForm value={value} onChange={setValue} />;
  }
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Harness });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  // RouterProvider paints nothing until the router has loaded once.
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await settle();
}

const dir = () => screen.getByLabelText("Working directory") as HTMLInputElement;

describe("NewSubshellForm working-dir pre-fill", () => {
  afterEach(cleanup);

  it("fills an empty working dir with the most recent path", async () => {
    const restore = mockEndpoints([
      { path: "/srv/app", label: "app" },
      { path: "/srv/older", label: null },
    ]);
    try {
      await renderForm(emptyNewSubshellForm());
      await waitFor(() => expect(dir().value).toBe("/srv/app"));
    } finally {
      restore();
    }
  });

  it("never overwrites a working dir the caller already set", async () => {
    const restore = mockEndpoints([{ path: "/srv/app", label: null }]);
    try {
      await renderForm({ ...emptyNewSubshellForm(), workingDir: "/keep/me" });
      expect(dir().value).toBe("/keep/me");
    } finally {
      restore();
    }
  });

  it("stays empty when the user has no history yet", async () => {
    const restore = mockEndpoints([]);
    try {
      await renderForm(emptyNewSubshellForm());
      expect(dir().value).toBe("");
    } finally {
      restore();
    }
  });

  it("scopes the recent-paths query to the selected node", async () => {
    const restore = mockEndpoints([{ path: "/srv/remote", label: null }]);
    try {
      await renderForm({ ...emptyNewSubshellForm(), nodeId: "node-7" });
      await waitFor(() => expect(dir().value).toBe("/srv/remote"));
      const recentUrl = restore.urls.find((u) => u.includes("/api/files/recent"));
      expect(recentUrl).toContain("node=node-7");
    } finally {
      restore();
    }
  });

  it("respects a user typing over the pre-fill (applies once per mount)", async () => {
    const restore = mockEndpoints([{ path: "/srv/app", label: null }]);
    try {
      await renderForm(emptyNewSubshellForm());
      await waitFor(() => expect(dir().value).toBe("/srv/app"));
      fireEvent.change(dir(), { target: { value: "" } }); // deliberate clear
      await settle();
      expect(dir().value).toBe("");
    } finally {
      restore();
    }
  });
});
