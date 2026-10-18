import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useWorkspacePaneMutations } from "@/hooks/use-workspace-pane-mutations";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { setFetchRouter } from "@/test-setup";
import type { WorkspacePaneRow, WorkspaceRow } from "@/types/workspace";

/**
 * The pane seam owns the cache wake (spec 2026-10-17 review): the LIST
 * carries each workspace's panes, the rail's tree renders from the LIST, and
 * the presentations only refetch their own DETAIL. Every add/remove — and
 * every already-gone delete, which means membership moved without this
 * client knowing — must refetch the LIST, or the sidebar keeps showing a pane
 * the dock already closed (the operator's original bug report).
 */
const pane: WorkspacePaneRow = {
  id: "p1",
  subshellId: "s1",
  subshellName: "one",
  subshellStatus: "running",
  subshellAlive: true,
  subshellExitCode: null,
  subshellWaitingSince: null,
  workingDir: "/srv",
};

const row: WorkspaceRow = {
  id: "w1",
  name: "Alpha",
  layout: null,
  subshellCount: 1,
  panes: [pane],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function harness({ deleteStatus = 200 }: { deleteStatus?: number } = {}) {
  let listGets = 0;
  const posted: string[] = [];
  setFetchRouter(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = String(req.url);
    if (url.endsWith("/api/workspaces") && req.method === "GET") {
      listGets += 1;
      return new Response(JSON.stringify([row]), { status: 200 });
    }
    if (url.endsWith("/api/workspaces/w1/panes") && req.method === "POST") {
      posted.push(url);
      return new Response(JSON.stringify({ id: "p2" }), { status: 200 });
    }
    if (url.endsWith("/api/workspaces/w1/panes/p1") && req.method === "DELETE") {
      posted.push(url);
      return deleteStatus === 200
        ? new Response(JSON.stringify({ ok: true, workspaceDeleted: false }), { status: 200 })
        : new Response(JSON.stringify({ error: "gone" }), { status: deleteStatus });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  // The LIST consumer is what makes the invalidation VISIBLE: an invalidate
  // refetches active queries, so a second GET is the observable wake.
  const { result } = renderHook(() => ({ mut: useWorkspacePaneMutations("w1"), list: useWorkspaces() }), {
    wrapper,
  });
  return { result, posted, listGets: () => listGets };
}

afterEach(() => {
  cleanup();
  setFetchRouter(null);
});

describe("useWorkspacePaneMutations cache wake", () => {
  it("an ADD refetches the LIST the tree branches render from", async () => {
    const h = harness();
    await waitFor(() => expect(h.result.current.list.data).toBeTruthy());
    const before = h.listGets();
    await act(async () => {
      await h.result.current.mut.addPane("s2");
    });
    expect(h.posted.some((u) => u.endsWith("/api/workspaces/w1/panes"))).toBe(true);
    await waitFor(() => expect(h.listGets()).toBeGreaterThan(before));
  });

  it("a REMOVE refetches the LIST (the tab-close staleness the operator caught)", async () => {
    const h = harness();
    await waitFor(() => expect(h.result.current.list.data).toBeTruthy());
    const before = h.listGets();
    await act(async () => {
      const res = await h.result.current.mut.removePane("p1");
      expect(res.workspaceDeleted).toBe(false);
    });
    await waitFor(() => expect(h.listGets()).toBeGreaterThan(before));
  });

  it("an already-gone REMOVE still refetches: someone else moved membership", async () => {
    const h = harness({ deleteStatus: 404 });
    await waitFor(() => expect(h.result.current.list.data).toBeTruthy());
    const before = h.listGets();
    await act(async () => {
      const res = await h.result.current.mut.removePane("p1");
      expect(res).toEqual({ workspaceDeleted: false });
    });
    await waitFor(() => expect(h.listGets()).toBeGreaterThan(before));
  });

  it("a FAILED remove does not wake anything (nothing moved)", async () => {
    const h = harness({ deleteStatus: 500 });
    await waitFor(() => expect(h.result.current.list.data).toBeTruthy());
    const before = h.listGets();
    let threw = false;
    await act(async () => {
      await h.result.current.mut.removePane("p1").catch(() => {
        threw = true;
      });
    });
    expect(threw).toBe(true);
    // Give any (wrongly) scheduled refetch a window to land, then hold.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.listGets()).toBe(before);
  });
});
