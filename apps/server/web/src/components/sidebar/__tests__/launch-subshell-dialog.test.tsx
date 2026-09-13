import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import { LaunchSubshellDialog } from "@/components/sidebar/launch-subshell-dialog";

/**
 * Gating + composition only: the form itself is pinned by new-subshell-form.
 * test.tsx and the POST by use-create-subshell's existing coverage — filling
 * the searchable agent combobox here would re-test the combobox, not the
 * dialog. The launch flow is e2e-pinned on /new (same hooks).
 */
afterEach(cleanup);

async function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  // The dialog rides a route component: RouterProvider renders its `children`
  // only while loading, not after (the new-subshell-form.test.tsx idiom).
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <LaunchSubshellDialog open onOpenChange={() => {}} />,
  });
  const subshellRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/subshells/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, subshellRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // Flush the portal mount + the form's initial queries (retry off; failures
  // land as empty option lists, which still render).
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe("LaunchSubshellDialog", () => {
  it("renders the shared launch form behind a titled dialog, Start gated until complete", async () => {
    await renderDialog();
    expect(await screen.findByText("New subshell")).toBeDefined();
    // The dialog's default (DIALOG_IDS) working-dir field id is shared with the
    // workspace add-dialog — both instances never mount at once.
    expect(document.querySelector("#picker-working-dir")).not.toBeNull();
    const start = screen.getByRole("button", { name: /Start subshell/i });
    expect(start.hasAttribute("disabled")).toBe(true);
  });
});
