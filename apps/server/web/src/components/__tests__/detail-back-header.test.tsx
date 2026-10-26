import { afterEach, describe, expect, it } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { DetailBackHeader } from "@/components/detail-back-header";
import { MobileNavProvider } from "@/components/mobile-nav-provider";

/** The header needs router context (Link + MobileNav's useLocation). */
async function renderHeader(extra: { subtitle?: string; hideBack?: boolean } = {}) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <MobileNavProvider>
        <DetailBackHeader
          to="/"
          backLabel="Back to subshells"
          title={<>Alpha</>}
          subtitle={extra.subtitle}
          hideBack={extra.hideBack}
        />
      </MobileNavProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return document.querySelector("header");
}

/**
 * matchMedia simulator answering the two queries the header reads:
 * `wide` for the tiling-width query, `coarse` for `(pointer: coarse)`.
 */
function forceViewport({ wide, coarse }: { wide: boolean; coarse: boolean }) {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) => ({
    matches: query.includes("pointer") ? coarse : wide,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof matchMedia;
  return () => (globalThis.matchMedia = original);
}

describe("DetailBackHeader", () => {
  afterEach(cleanup);

  // NOTE: no relying on the ambient matchMedia — happy-dom's own answers
  // width queries against a 1024px window (i.e. "wide"), so every test
  // forces its viewport and pointer explicitly.

  it("hideBack drops the back control from the chrome row", async () => {
    const restore = forceViewport({ wide: false, coarse: true });
    try {
      await renderHeader({ hideBack: true });
      expect(screen.queryByRole("link", { name: "Back to subshells" })).toBeNull();
      // The title still renders — the control left, not the whole header.
      expect(screen.getByText("Alpha")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("by default the back control is there", async () => {
    const restore = forceViewport({ wide: false, coarse: true });
    try {
      await renderHeader();
      expect(screen.queryByRole("link", { name: "Back to subshells" })).not.toBeNull();
    } finally {
      restore();
    }
  });
});
