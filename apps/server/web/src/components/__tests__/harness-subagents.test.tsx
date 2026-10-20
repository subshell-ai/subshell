import { afterEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setFetchRouter } from "@/test-setup";
import { HarnessSubagentRows, HarnessSubagentTitle } from "../harness-subagents";

// The router is a PROCESS global: leaving it set lets this file's snapshot
// object answer a later file's `/api/subshells` read as if it were a list
// (test-setup's afterEach resets the global fetch, but only to the delegator,
// which still routes through whatever router is live).
afterEach(() => {
  setFetchRouter(null);
  cleanup();
});

test("the compact header uses confirmed native selection and returns through the parent endpoint", async () => {
  const state = {
    pane: {
      agents: [{ id: "child", name: "Review changes", status: "running", startedAt: Date.now() - 65_000 }],
      selectedId: "child",
      canSelect: true,
    },
  };
  const sent: unknown[] = [];
  setFetchRouter(async (url, init) => {
    if (String(url).endsWith("/subagents/select")) {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    return Response.json(state);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["harness-subagents"], state);
  render(
    <QueryClientProvider client={client}>
      <HarnessSubagentTitle id="pane" parentName="Build feature" alive />
    </QueryClientProvider>,
  );
  expect(screen.getByText("Review changes")).toBeTruthy();
  // The branch mark is a label, not a control: it marks which agent the pane
  // is showing and activates nothing, so it sits out of the tab order.
  expect(screen.getByRole("img", { name: "Subagent of Build feature" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to main agent" }));
  await waitFor(() => expect(sent).toEqual([{ agentId: null }]));
  // A queued command is not confirmation that the harness changed views.
  expect(screen.getByText("Review changes")).toBeTruthy();
  client.clear();
});

test("a blocked child row explains itself with the task label and elapsed line", async () => {
  // Blocked rows (harnesses that keep views in-app, and every row mid-switch)
  // carry the same card through the disabled control's explanation: the
  // reason, the harness's own task label, and the time the server has seen
  // the child running.
  const state = {
    pane: {
      agents: [
        {
          id: "child",
          name: "code-reviewer",
          status: "running",
          activity: "Reading the diff",
          startedAt: Date.now() - 125_000,
        },
      ],
      selectedId: null,
      canSelect: false,
      unavailableReason: "pi keeps agent views in the app.",
    },
  };
  setFetchRouter(async () => Response.json(state));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["harness-subagents"], state);
  const rootRoute = createRootRoute({ component: () => <HarnessSubagentRows id="pane" alive /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const row = await screen.findByRole("button", { name: /code-reviewer/ });
  const described = row.getAttribute("aria-description") ?? "";
  expect(described).toContain("pi keeps agent views in the app.");
  expect(described).not.toContain("Reading the diff");
  expect(row.textContent).toContain("Reading the diff");
  // Minute-accurate on purpose: the stamp is seeded at 125 s and the render
  // happens whenever the runner gets to it, so the seconds bucket is one
  // starved CI tick away from rolling over. The minute carries the claim.
  expect(described).toMatch(/running · 2m \d+s/);
  // The reason here already ends in a period; the join must not double it,
  // and the sentence must close with exactly one.
  expect(described).not.toContain("..");
  expect(described.endsWith(".")).toBe(true);
  client.clear();
});

test("Claude hides descriptions that don't match live progress and still explains blocked navigation", async () => {
  // The server answers canSelect:false with no reason when the harness never
  // said why; the fallback sentence must still reach the row, or the disabled
  // control has nothing to explain itself with.
  const state = {
    pane: {
      agents: [
        {
          id: "child",
          name: "general-purpose",
          activity: "Review the sidebar",
          status: "running",
          startedAt: Date.now(),
        },
      ],
      selectedId: null,
      canSelect: false,
    },
  };
  setFetchRouter(async () => Response.json(state));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["harness-subagents"], state);
  const rootRoute = createRootRoute({
    component: () => <HarnessSubagentRows id="pane" harnessId="claude-code" alive />,
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const row = await screen.findByRole("button", { name: /general-purpose/ });
  expect(screen.queryByText("Review the sidebar")).toBeNull();
  expect(screen.getByRole("img", { name: "running" })).toBeTruthy();
  expect(row.getAttribute("aria-description")).toContain("Subshell can't switch views");
  expect(row.getAttribute("aria-description")).not.toContain("Review the sidebar");
  client.clear();
});

test("a switch in flight blocks every surface of the pane, and a refusal says so", async () => {
  // Pending belongs to the pane, not to the button that sent the POST: the
  // header's return and the rows share the pane's one queued command, so a
  // click on either surface must block all of them while it is on the wire.
  const state = {
    pane: {
      agents: [
        { id: "a", name: "alpha", status: "running", startedAt: Date.now() },
        { id: "b", name: "beta", status: "running", startedAt: Date.now() },
      ],
      selectedId: "a",
      canSelect: true,
    },
  };
  let mode: "hold" | "fail" = "hold";
  let release: () => void = () => {};
  setFetchRouter(async (url) => {
    if (String(url).endsWith("/subagents/select")) {
      if (mode === "hold") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return Response.json({ ok: true });
      }
      return Response.json({ error: "gone" }, { status: 409 });
    }
    return Response.json(state);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["harness-subagents"], state);
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <HarnessSubagentRows id="pane" alive />
        <HarnessSubagentTitle id="pane" parentName="Build" alive />
      </>
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const back = (await screen.findByRole("button", { name: "Back to main agent" })) as HTMLButtonElement;
  expect(back.disabled).toBe(false);
  // The rows need their own settle: the tree renders the surface and the
  // batch read answers from cache, but beta's button only exists once the
  // router has painted.
  await screen.findByRole("button", { name: /beta/ });
  fireEvent.click(back);
  // The held fetch must release even if the block assertion fails: a stuck
  // in-flight entry belongs to the module-level store, so it would render
  // every later switch surface in this file blocked (and skip the client
  // clear below). Same rule the add-subshell dialog's release comment pins.
  try {
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /beta/ }).getAttribute("aria-description")).toContain(
        "Switching agent views",
      ),
    );
  } finally {
    await act(async () => release());
  }
  // A refused switch explains itself on the surface that failed.
  mode = "fail";
  fireEvent.click(screen.getByRole("button", { name: /beta/ }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.getByRole("alert").textContent).toContain("Couldn't switch agent views");
  client.clear();
});

test("a dead parent keeps no child to show, even from the cached snapshot", async () => {
  // The poll stops for a dead pane (`enabled` false), but a DISABLED query
  // still serves whatever sits in the cache — and the batch ticker stops
  // when nothing watches, so a cached selection can outlive the pane
  // INDEFINITELY while its detail page is open. The docstring's promise is
  // "a dead row keeps no child to show"; this pins it at the render, where
  // the cache serves it, not just at the fetch.
  const state = {
    pane: {
      agents: [{ id: "child", name: "Review changes", status: "running", startedAt: Date.now() }],
      selectedId: "child",
      canSelect: true,
    },
  };
  const reads: string[] = [];
  setFetchRouter(async (url) => {
    if (String(url).includes("/subshells/subagents") && !String(url).endsWith("/select")) reads.push(String(url));
    return Response.json(state);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["harness-subagents"], state);
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <HarnessSubagentTitle id="pane" parentName="Build" alive={false} />
        <HarnessSubagentRows id="pane" alive={false} />
      </>
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(screen.queryByText("Review changes")).toBeNull();
  expect(screen.queryByRole("button", { name: "Back to main agent" })).toBeNull();
  // And the dead pane starts no watch over the batch read.
  expect(reads).toHaveLength(0);
  client.clear();
});
