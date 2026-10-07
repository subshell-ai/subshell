import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { SshRuntimePaneIdentity } from "@/components/connect/ssh-runtime-pane-identity";
import { SSH_PANE_IDENTITY_QUERY_KEY } from "@/hooks/use-ssh-runtime";
import type { SshRuntimePaneIdentity as IdentityFacts } from "@/lib/ssh-runtime";

/**
 * The qualified identity line (wave-2 review M4/R2-1): a pane whose session
 * channel is gone must never read as a live destination. Both departures get
 * their suffix - `connection lost` for a dropped link (design §6:
 * unavailable, not completed) and `closed` for an ended one - while a live
 * session renders the bare line.
 */

function facts(status: IdentityFacts["status"]): IdentityFacts {
  return {
    sessionId: "s1",
    status,
    alias: "staging",
    host: "app-02",
    port: 22,
    user: "deploy",
    connectingNodeName: "Laptop",
  };
}

const savedFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = savedFetch;
});

function stubIdentity(data: IdentityFacts | null) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
      status: data === null ? 404 : 200,
    })) as never;
}

async function renderLine(status: IdentityFacts["status"] | null) {
  stubIdentity(status === null ? null : facts(status));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  // Seed nothing; the component's own read carries the state. The query key
  // is asserted once to pin the shared prefix the close mutation invalidates
  // (the R2-1 invalidation half rides exactly that key).
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <SshRuntimePaneIdentity subshellId="p1" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
}

describe("SshRuntimePaneIdentity qualification (M4)", () => {
  it("renders the bare line for a live session", async () => {
    await renderLine("active");
    await waitFor(() => expect(screen.getByText(/SSH ·/)).toBeTruthy());
    expect(screen.getByText(/SSH ·/).textContent).not.toContain("lost");
    expect(screen.getByText(/SSH ·/).textContent).not.toContain("closed");
  });

  it("qualifies a dropped link as connection lost, never a completed pane", async () => {
    await renderLine("lost");
    await waitFor(() => expect(screen.getByText(/SSH ·/).textContent ?? "").toContain("connection lost"));
  });

  it("qualifies an ended session as closed", async () => {
    await renderLine("closed");
    await waitFor(() => expect(screen.getByText(/SSH ·/).textContent ?? "").toContain(" · closed"));
  });

  it("renders nothing on the ordinary-pane 404", async () => {
    await renderLine(null);
    await waitFor(() => expect(screen.queryByText(/SSH ·/)).toBeNull());
  });

  it("the read rides the shared key the close mutation invalidates", async () => {
    // Pin the coupling rather than trust the comment: the component's OWN
    // query must register under SSH_PANE_IDENTITY_QUERY_KEY, or the close
    // mutation's prefix invalidation silently stops re-asking a mounted pane
    // line. Reading the cache the component filled (not one we filled) is
    // what makes a divergent literal key fail this test.
    const client = await renderLine("active");
    await waitFor(() =>
      expect(
        client
          .getQueryCache()
          .getAll()
          .some((q) => JSON.stringify(q.queryKey) === JSON.stringify([...SSH_PANE_IDENTITY_QUERY_KEY, "p1"])),
      ).toBe(true),
    );
  });
});
