import { afterEach, describe, expect, it } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { NotFoundPage, SubshellNotFoundCard } from "@/components/not-found-page";

/** Renders inside a throwaway router — both cards contain a Link, which
 *  needs router context (the throwaway-router pattern from
 *  clone-subshell-dialog.test.tsx). */
function renderWithRouter(component: () => React.ReactElement) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

describe("NotFoundPage", () => {
  afterEach(cleanup);

  it("says the page doesn't exist and offers the way back to the list", async () => {
    renderWithRouter(NotFoundPage);
    expect(await screen.findByText("Page not found")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Go to subshells" });
    // `/` is the workspace landing now (spec 2026-10-17): a link that SAYS
    // "subshells" has to land on the list, not on a page that may redirect to
    // a workspace or an empty state (review 2026-10-17: round 2 changed the
    // component and never reached this file).
    expect(link.getAttribute("href")).toBe("/subshells");
  });
});

describe("SubshellNotFoundCard", () => {
  afterEach(cleanup);

  it("names the two honest reasons and links back", async () => {
    renderWithRouter(SubshellNotFoundCard);
    expect(await screen.findByText("Subshell not found")).toBeTruthy();
    expect(screen.getByText(/deleted/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Back to subshells" });
    expect(link.getAttribute("href")).toBe("/subshells");
  });
});
