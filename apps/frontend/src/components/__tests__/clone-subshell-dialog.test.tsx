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
import type { SessionView } from "@/types/session";

/** Minimal full view (mirrors session-actions-menu's fixture) with overrides. */
function makeSource(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "src-1",
    profileId: "profile-1",
    harnessId: "claude",
    nodeId: "mac-mini",
    nodeOffline: false,
    name: "source",
    nameLocked: false,
    terminalReplayLines: null,
    workingDir: "/home/theo/projects/demo",
    status: "running",
    createdAt: "2026-09-02T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    notes: null,
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
  it("copies profile/dir/node and trims the name; absent node means local", () => {
    expect(cloneInputFromSource(makeSource(), "  Copy  ")).toEqual({
      profileId: "profile-1",
      workingDir: "/home/theo/projects/demo",
      nodeId: "mac-mini",
      name: "Copy",
    });
    expect(cloneInputFromSource(makeSource({ nodeId: undefined }), "").nodeId).toBe("local");
  });
});

describe("CloneSubshellDialog", () => {
  afterEach(cleanup);

  /** Records fetch calls (JSON bodies parsed, so comparisons are
   *  key-order independent); profiles/node lists answer with one row each;
   *  the create POST answers with a new id. */
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
      if (url.pathname === "/api/profiles")
        return Promise.resolve(
          new Response(JSON.stringify([{ id: "profile-1", name: "Claude", harnessId: "claude" }])),
        );
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
   *  from new-session-form.test.tsx — keeps "not wrapped in act" out of the log). */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }

  /** Renders the dialog inside a throwaway router (it calls useNavigate),
   *  loaded and settled so the first paint and the profiles/nodes queries
   *  have landed by the time the caller asserts. */
  async function renderDialog(source: SessionView, onOpenChange = (_: boolean) => {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <CloneSubshellDialog source={source} open onOpenChange={onOpenChange} />,
    });
    // The success path navigates here; without the route the test router
    // swaps in its notFound view (new.tsx's real route is the same path).
    const sessionRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/sessions/$id",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, sessionRoute]),
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

  it("shows the copied node, profile and working directory read-only and launches with the typed name", async () => {
    const { calls, restore } = mockFetch();
    try {
      await renderDialog(makeSource());
      expect(await screen.findByText("mac-mini · darwin/arm64")).toBeDefined();
      expect(screen.getByText("Claude (claude)")).toBeDefined();
      expect(screen.getByText("/home/theo/projects/demo")).toBeDefined();
      fireEvent.change(screen.getByRole("textbox", { name: "Clone name" }), { target: { value: "demo copy" } });
      fireEvent.click(screen.getByRole("button", { name: "Launch clone" }));
      await waitFor(() =>
        expect(calls).toContainEqual({
          method: "POST",
          url: "/api/sessions",
          body: {
            profileId: "profile-1",
            workingDir: "/home/theo/projects/demo",
            nodeId: "mac-mini",
            name: "demo copy",
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
