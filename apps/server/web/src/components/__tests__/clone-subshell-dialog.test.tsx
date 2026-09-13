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
import { CloneSubshellDialog, cloneInputFromSource } from "@/components/clone-subshell-dialog";
import type { SubshellView } from "@/types/subshell";

/** Minimal full view (mirrors subshell-actions-menu's fixture) with overrides. */
function makeSource(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "src-1",
    presetId: "preset-1",
    harnessId: "claude",
    nodeId: "mac-mini",
    nodeOffline: false,
    name: "source",
    nameLocked: false,
    workingDir: "/home/theo/projects/demo",
    status: "running",
    createdAt: "2026-09-02T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: false,
    waitingSince: null,
    access: "owner",
    ...overrides,
  };
}

describe("cloneInputFromSource", () => {
  it("copies agent/preset/dir/node and trims the name; absent node means local", () => {
    expect(cloneInputFromSource(makeSource(), "  Copy  ")).toEqual({
      harnessId: "claude",
      presetId: "preset-1",
      workingDir: "/home/theo/projects/demo",
      nodeId: "mac-mini",
      name: "Copy",
    });
    expect(cloneInputFromSource(makeSource({ nodeId: undefined }), "").nodeId).toBe("local");
  });
  it("a presetless source clones presetless — null, not an invented id", () => {
    expect(cloneInputFromSource(makeSource({ presetId: null }), "x").presetId).toBeNull();
  });
});

describe("CloneSubshellDialog", () => {
  afterEach(cleanup);

  /** Records fetch calls (JSON bodies parsed, so comparisons are
   *  key-order independent); presets/plugins/node lists answer with one row
   *  each; the create POST answers with a new id. */
  function mockFetch(createBody?: unknown) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.pathname === "/api/presets")
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "preset-1",
                harnessId: "claude",
                name: "Work",
                description: null,
                envJson: null,
                flagsJson: null,
                settingsJson: null,
                configIsolation: 0,
                restartOnExit: 0,
                createdAt: "2026-09-13T00:00:00.000Z",
                updatedAt: "2026-09-13T00:00:00.000Z",
              },
            ]),
          ),
        );
      if (url.pathname === "/api/plugins")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              plugins: [
                { id: "claude", name: "Claude Code", description: "", installed: true, enabled: true, builtIn: true },
              ],
            }),
          ),
        );
      if (url.pathname === "/api/subshells" && method === "GET")
        return Promise.resolve(new Response(JSON.stringify([])));
      if (url.pathname === "/api/nodes")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              nodes: [
                {
                  id: "mac-mini",
                  kind: "agent",
                  status: "ready",
                  name: "mac-mini",
                  os: "darwin",
                  arch: "arm64",
                  harnesses: [],
                },
              ],
            }),
          ),
        );
      if (createBody !== undefined) return Promise.resolve(new Response(JSON.stringify(createBody), { status: 409 }));
      return Promise.resolve(new Response(JSON.stringify({ id: "new-1" })));
    }) as typeof fetch;
    return {
      calls,
      restore: () => {
        globalThis.fetch = original;
      },
    };
  }

  /** Flush pending query/effect updates inside act() (the repo-wide pattern
   *  from new-subshell-form.test.tsx — keeps "not wrapped in act" out of the log). */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }

  /** Renders the dialog inside a throwaway router (it calls useNavigate),
   *  loaded and settled so the first paint and the presets/nodes queries
   *  have landed by the time the caller asserts. */
  async function renderDialog(source: SubshellView, onOpenChange = (_: boolean) => {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <CloneSubshellDialog source={source} open onOpenChange={onOpenChange} />,
    });
    // The success path navigates here; without the route the test router
    // swaps in its notFound view (new.tsx's real route is the same path).
    const subshellRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/subshells/$id",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, subshellRoute]),
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

  it("shows agent, preset, node and working directory read-only and launches with the typed name", async () => {
    const { calls, restore } = mockFetch();
    try {
      // Captures every onOpenChange argument so the success path can assert the
      // close, not just the POST (Task 2 review gap-closer — the component
      // already does this; the assertion is what was missing).
      const openArgs: boolean[] = [];
      await renderDialog(makeSource(), (o) => {
        openArgs.push(o);
      });
      expect(await screen.findByText("mac-mini · darwin/arm64")).toBeDefined();
      expect(screen.getByText("Claude Code")).toBeDefined();
      expect(screen.getByText("Work")).toBeDefined();
      expect(screen.getByText("/home/theo/projects/demo")).toBeDefined();
      fireEvent.change(screen.getByRole("textbox", { name: "Clone name" }), { target: { value: "demo copy" } });
      fireEvent.click(screen.getByRole("button", { name: "Launch clone" }));
      await waitFor(() =>
        expect(calls).toContainEqual({
          method: "POST",
          url: "/api/subshells",
          body: {
            harnessId: "claude",
            presetId: "preset-1",
            workingDir: "/home/theo/projects/demo",
            nodeId: "mac-mini",
            name: "demo copy",
          },
        }),
      );
      // A successful launch closes the dialog (the navigate that follows leaves
      // a still-open dialog over a dead route otherwise).
      await waitFor(() => expect(openArgs).toContain(false));
    } finally {
      restore();
    }
  });

  it("a preset that no longer resolves reads as prose, never as its uuid", async () => {
    // Reachable two ways now: the preset was deleted, or its plugin was
    // disabled — availability is the instance store (spec 2026-09-13
    // amendment), so a disabled plugin's presets leave the list while the
    // subshell row keeps pointing at one. A dialog whose job is "here is what
    // will be copied" cannot answer that with a uuid.
    const { restore } = mockFetch();
    try {
      await renderDialog(makeSource({ presetId: "00000000-0000-4000-8000-000000000000" }));
      expect(await screen.findByText("(preset no longer available)")).toBeDefined();
      expect(screen.queryByText("00000000-0000-4000-8000-000000000000")).toBeNull();
    } finally {
      restore();
    }
  });

  it("a presetless source reads None and posts no presetId", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderDialog(makeSource({ presetId: null }));
      expect(await screen.findByText("None")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Launch clone" }));
      await waitFor(() =>
        expect(calls).toContainEqual({
          method: "POST",
          url: "/api/subshells",
          body: {
            harnessId: "claude",
            workingDir: "/home/theo/projects/demo",
            nodeId: "mac-mini",
          },
        }),
      );
    } finally {
      restore();
    }
  });

  it("a rejected launch shows the mapped error and keeps the dialog open", async () => {
    const { restore } = mockFetch({ message: "node is offline", code: "NODE_OFFLINE" });
    try {
      let closed: boolean | undefined;
      await renderDialog(makeSource(), (o) => {
        closed = o;
      });
      fireEvent.click(screen.getByRole("button", { name: "Launch clone" }));
      expect(await screen.findByText(/start its subshell or pick another node/i)).toBeDefined();
      expect(closed).toBeUndefined();
    } finally {
      restore();
    }
  });
});
