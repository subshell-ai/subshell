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
  it("phone (narrow, coarse pointer): chrome row, then the title with the subtitle stacked UNDER it", async () => {
    const restore = forceViewport({ wide: false, coarse: true });
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

  it("narrow desktop window (fine pointer): one row, title over subtitle inside it", async () => {
    const restore = forceViewport({ wide: false, coarse: false });
    try {
      const header = await renderHeader({ subtitle: "/home/theo/projects/subshell" });
      // One row: the header itself is a horizontal bar, no chrome/title split.
      expect(header?.className).not.toContain("flex-col");
      const title = screen.getByText("Alpha");
      const subtitle = screen.getByText("/home/theo/projects/subshell");
      // Two lines: title and subtitle share a vertical block flanked by the
      // chrome and actions, rather than competing for one baseline.
      expect(subtitle.parentElement).toBe(title.parentElement);
      expect(title.parentElement?.className).toContain("flex-col");
    } finally {
      restore();
    }
  });

  it("wide: one row with the title/subtitle block beside the actions", async () => {
    const restore = forceViewport({ wide: true, coarse: false });
    try {
      const header = await renderHeader({ subtitle: "/tmp/x" });
      expect(header?.className).not.toContain("flex-col");
      expect(screen.getByText("Alpha")).toBeDefined();
      expect(screen.getByText("/tmp/x")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("subtitle absent: phone layout carries just the title", async () => {
    const restore = forceViewport({ wide: false, coarse: true });
    try {
      const header = await renderHeader();
      expect(header?.className).toContain("flex-col");
      expect(screen.getByText("Alpha")).toBeDefined();
    } finally {
      restore();
    }
  });
});
