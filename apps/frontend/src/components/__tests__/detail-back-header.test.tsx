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
      <DetailBackHeader to="/" backLabel="Back to subshells" title={<>Alpha</>} subtitle={extra.subtitle} />
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
  it("narrow: chrome row, then the title with the subtitle stacked UNDER it", async () => {
    const restore = forceViewport(false);
    try {
      const header = await renderHeader({ subtitle: "/home/theo/projects/subshell" });
      expect(header?.className).toContain("flex-col");
      const title = screen.getByText("Alpha");
      const subtitle = screen.getByText("/home/theo/projects/subshell");
      // Same stacked container: the subtitle's parent is a flex-col that
      // also holds the title — never a sibling on the title's line.
      expect(subtitle.parentElement).toBe(title.parentElement);
      expect(subtitle.parentElement?.className).toContain("flex-col");
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
