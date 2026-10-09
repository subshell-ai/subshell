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
import { SetupHereDialog } from "@/components/setup-here-dialog";
import type { SubshellView } from "@/types/subshell";

/** Minimal ssh pane view (the menu fixture's shape) with overrides. */
function makeSshPane(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "pane-1",
    presetId: null,
    harnessId: "ssh",
    nodeId: "mac-mini",
    nodeOffline: false,
    name: "deploy box",
    nameLocked: false,
    workingDir: "/home/scripted",
    status: "running",
    createdAt: "2026-10-08T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "active",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: false,
    waitingSince: null,
    unseenPush: false,
    access: "owner",
    ssh: true,
    ...overrides,
  };
}

describe("SetupHereDialog", () => {
  afterEach(cleanup);

  /** fetch recorder; the setup POST answers per the case's script. */
  function mockFetch(answer: { status?: number; body: unknown }) {
    const calls: { url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      calls.push({ url: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return Promise.resolve(
        url.pathname.startsWith("/api/ssh/setup-here/")
          ? new Response(JSON.stringify({ operation: null }))
          : new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 }),
      );
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = original) };
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }

  async function renderDialog(subshell: SubshellView, onOpenChange = (_: boolean) => {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <SetupHereDialog subshell={subshell} open onOpenChange={onOpenChange} />,
    });
    const nodeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/nodes/$id",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, nodeRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      defaultPreload: false,
    });
    await router.load();
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await settle();
  }

  it("asks once with a static title and two sentences, then posts the pane id", async () => {
    const { calls, restore } = mockFetch({ body: { nodeId: "new-node-1" } });
    try {
      await renderDialog(makeSshPane());
      expect(screen.getByText("Set up Subshell here?")).toBeTruthy();
      expect(screen.getByText(/keep running/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Set up Subshell" }));
      await settle();
      const post = calls.find((c) => c.url === "/api/ssh/setup-here");
      expect(post?.body).toEqual({ paneId: "pane-1" });
    } finally {
      restore();
    }
  });

  it("success names the enrolled machine and links to its page", async () => {
    const { restore } = mockFetch({ body: { nodeId: "new-node-1" } });
    try {
      let closed = false;
      await renderDialog(makeSshPane(), () => (closed = true));
      fireEvent.click(screen.getByRole("button", { name: "Set up Subshell" }));
      await waitFor(() => expect(screen.queryByText(/Installing on the destination/)).toBeNull());
      const link = screen.getByRole("link", { name: "Open its page" }) as HTMLAnchorElement;
      expect(link.getAttribute("href")).toContain("/nodes/new-node-1");
      // Done leaves; the finished answer does not outlive the dialog (mount-
      // while-open posture, checked at the menu level).
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(closed).toBe(true);
    } finally {
      restore();
    }
  });

  it("the server's named refusal is shown verbatim, in destructive, and the act can be retried", async () => {
    const { calls, restore } = mockFetch({
      status: 409,
      body: {
        code: "SSH_UPGRADE_EGRESS",
        message:
          "The destination could not reach http://plane.test, so it cannot install Subshell. Nothing was enrolled; the connection and its pane are untouched.",
      },
    });
    try {
      await renderDialog(makeSshPane());
      fireEvent.click(screen.getByRole("button", { name: "Set up Subshell" }));
      await waitFor(() => expect(screen.getByText(/could not reach/)).toBeTruthy());
      expect(screen.getByText(/untouched/)).toBeTruthy();
      // The act button comes back: a refused act is retriable (the key was
      // minted and revoked fresh per run).
      fireEvent.click(screen.getByRole("button", { name: "Set up Subshell" }));
      await settle();
      expect(calls.filter((c) => c.url === "/api/ssh/setup-here")).toHaveLength(2);
    } finally {
      restore();
    }
  });
  it("can close and reopen an install without another POST, including after a page remount", async () => {
    const original = globalThis.fetch;
    let posts = 0;
    let operation: { stage: string; startedAt: string; nodeId: string | null; error: null } | null = null;
    let finish!: (value: Response) => void;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts++;
        operation = { stage: "installing", startedAt: new Date().toISOString(), nodeId: null, error: null };
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ operation })));
    }) as typeof fetch;
    try {
      let closed = false;
      await renderDialog(makeSshPane(), () => {
        closed = true;
      });
      fireEvent.click(screen.getByRole("button", { name: "Set up Subshell" }));
      fireEvent.click(await screen.findByRole("button", { name: "Continue working" }));
      expect(closed).toBe(true);
      cleanup();
      await renderDialog(makeSshPane());
      expect(screen.getByText(/Installing on the destination/)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Setting up…" }) as HTMLButtonElement).disabled).toBe(true);
      expect(posts).toBe(1);
      operation = { stage: "complete", startedAt: new Date().toISOString(), nodeId: "new-node", error: null };
      finish(new Response(JSON.stringify({ nodeId: "new-node" })));
      expect(await screen.findByRole("link", { name: "Open its page" }, { timeout: 3000 })).toBeTruthy();
      expect(posts).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
