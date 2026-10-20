import { afterEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      <HarnessSubagentTitle id="pane" parentName="Build feature" />
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
  expect(described).toContain("Reading the diff");
  expect(described).toContain("running for 2m 5s");
  client.clear();
});
