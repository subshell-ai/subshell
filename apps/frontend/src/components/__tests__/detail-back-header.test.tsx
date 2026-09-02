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

/** The header needs router context (Link + MobileNav's useLocation). */
async function renderHeader(extra: { subtitle?: string } = {}) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <DetailBackHeader to="/" backLabel="Back to sessions" title={<>Alpha</>} subtitle={extra.subtitle} />
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

/** matchMedia whose queries all answer `matches` (viewport width simulator). */
function forceViewport(matches: boolean) {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) => ({
    matches,
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
  // forces its viewport explicitly.
  it("narrow: two rows, title + subtitle on row 2", async () => {
    const restore = forceViewport(false);
    try {
      const header = await renderHeader({ subtitle: "/home/theo/projects/mote" });
      expect(header?.className).toContain("flex-col");
      expect(screen.getByText("Alpha")).toBeDefined();
      expect(screen.getByText("/home/theo/projects/mote")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("wide: one row, subtitle inline after the title", async () => {
    const restore = forceViewport(true);
    try {
      const header = await renderHeader({ subtitle: "/tmp/x" });
      expect(header?.className).not.toContain("flex-col");
      expect(screen.getByText("Alpha")).toBeDefined();
      expect(screen.getByText("/tmp/x")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("subtitle absent: narrow layout carries just the title", async () => {
    const restore = forceViewport(false);
    try {
      const header = await renderHeader();
      expect(header?.className).toContain("flex-col");
      expect(screen.getByText("Alpha")).toBeDefined();
    } finally {
      restore();
    }
  });
});
