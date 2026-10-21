import { describe, expect, it } from "bun:test";
import type { InfiniteData } from "@tanstack/react-query";
import { EXPLORE_PREFETCH_ROWS, patchExploreFavorite, shouldFetchNextPage } from "@/lib/explore-pagination";
import type { ExploreResult } from "@/types/files";

/**
 * The tail predicate drives cursor paging, and the case that cannot be seen
 * in a browser is the page that adds zero folders TO A LOADED LISTING: the
 * count and the window both stay unchanged, and the answer must stay true.
 * The two deliberate stops (a failed page, a listing with no dirs at all)
 * are arithmetic too. These table rows pin all of it directly.
 */
describe("shouldFetchNextPage", () => {
  // A 300-folder listing has its trigger line at 300 - 1 - 20 = 279.
  it("fires when the window has reached the trigger line exactly", () => {
    expect(
      shouldFetchNextPage({
        lastVisibleIndex: 300 - 1 - EXPLORE_PREFETCH_ROWS,
        totalLoadedDirs: 300,
        hasNextPage: true,
        isFetchingNextPage: false,
        lastFetchFailed: false,
      }),
    ).toBe(true);
  });

  it("holds off while the window is still above the trigger line", () => {
    expect(
      shouldFetchNextPage({
        lastVisibleIndex: 300 - 2 - EXPLORE_PREFETCH_ROWS,
        totalLoadedDirs: 300,
        hasNextPage: true,
        isFetchingNextPage: false,
        lastFetchFailed: false,
      }),
    ).toBe(false);
  });

  it("fires at the tail of a full view when there is a page to fetch", () => {
    expect(
      shouldFetchNextPage({
        lastVisibleIndex: 7,
        totalLoadedDirs: 12,
        hasNextPage: true,
        isFetchingNextPage: false,
        lastFetchFailed: false,
      }),
    ).toBe(true);
  });

  it("holds when the walk is exhausted, tail in view and all", () => {
    expect(
      shouldFetchNextPage({
        lastVisibleIndex: 2,
        totalLoadedDirs: 3,
        hasNextPage: false,
        isFetchingNextPage: false,
        lastFetchFailed: false,
      }),
    ).toBe(false);
  });

  it("holds while a page is already in flight, whatever the window shows", () => {
    expect(
      shouldFetchNextPage({
        lastVisibleIndex: 299,
        totalLoadedDirs: 300,
        hasNextPage: true,
        isFetchingNextPage: true,
        lastFetchFailed: false,
      }),
    ).toBe(false);
  });

  it("keeps walking a zero-new-dirs page when rows are loaded: the no-stall rule reads the TOTAL", () => {
    // The newest page added nothing: count and window both unchanged. The
    // trigger reads against the total (still 300), so the walk goes on.
    expect(
      shouldFetchNextPage({
        lastVisibleIndex: 279,
        totalLoadedDirs: 300,
        hasNextPage: true,
        isFetchingNextPage: false,
        lastFetchFailed: false,
      }),
    ).toBe(true);
  });

  it("stops the walk when the last page fetch failed: the error is sticky and nothing forces a retry", () => {
    // Same window that pages on a healthy walk: without this stop the tail
    // effect re-fires on every flag flip and loops a dead endpoint at
    // network speed. The cached listing stays; the next navigation re-walks.
    expect(
      shouldFetchNextPage({
        lastVisibleIndex: 1,
        totalLoadedDirs: 2,
        hasNextPage: true,
        isFetchingNextPage: false,
        lastFetchFailed: true,
      }),
    ).toBe(false);
  });

  it("stops a listing that rendered no dirs at all: an empty virtualizer can never leave the margin", () => {
    // The node_modules shape: a files-only directory whose every page sits
    // "within the margin" at -1, so a predicate that answered true here
    // would walk the entire cursor chain (hundreds of requests) to render
    // nothing. Page 1 never consults this predicate, so the first page of
    // such a listing still arrives; folders sorting past it need a typed path.
    expect(
      shouldFetchNextPage({
        lastVisibleIndex: -1,
        totalLoadedDirs: 0,
        hasNextPage: true,
        isFetchingNextPage: false,
        lastFetchFailed: false,
      }),
    ).toBe(false);
  });

  it("holds an empty listing with no cursor left (a truly empty final page)", () => {
    expect(
      shouldFetchNextPage({
        lastVisibleIndex: -1,
        totalLoadedDirs: 0,
        hasNextPage: false,
        isFetchingNextPage: false,
        lastFetchFailed: false,
      }),
    ).toBe(false);
  });

  it("holds a far-off listing when the virtualizer has no window yet", () => {
    // range is null before the first update pass: -1 must not page-hammer a
    // big listing, only clear for the small ones already inside the margin.
    expect(
      shouldFetchNextPage({
        lastVisibleIndex: -1,
        totalLoadedDirs: 500,
        hasNextPage: true,
        isFetchingNextPage: false,
        lastFetchFailed: false,
      }),
    ).toBe(false);
    expect(
      shouldFetchNextPage({
        lastVisibleIndex: -1,
        totalLoadedDirs: 2,
        hasNextPage: true,
        isFetchingNextPage: false,
        lastFetchFailed: false,
      }),
    ).toBe(true);
  });
});

/** A cache shape with N pages, each carrying `dirs` folders and the shortcuts. */
function listing(pages: { dirs: number; favorites?: string[]; recent?: string[] }[]): InfiniteData<ExploreResult> {
  return {
    pageParams: pages.map(() => ""),
    pages: pages.map((p, i) => ({
      path: `/x`,
      parent: "/",
      entries: Array.from({ length: p.dirs }, (_, d) => ({
        name: `d${i}-${d}`,
        path: `/x/d${i}-${d}`,
        kind: "dir" as const,
      })),
      recent: (p.recent ?? []).map((path) => ({ path, label: null })),
      favorites: (p.favorites ?? []).map((path) => ({ path, label: null })),
    })),
  };
}

describe("patchExploreFavorite", () => {
  it("stars a path: favorites gain it first (newest first), recent loses it, every page patched", () => {
    const before = listing([
      { dirs: 2, favorites: ["/keep"], recent: ["/star/me", "/other"] },
      { dirs: 1, favorites: ["/keep"], recent: ["/star/me"] },
    ]);
    const after = patchExploreFavorite(before, "/star/me", true);
    expect(after?.pages.map((p) => p.favorites.map((f) => f.path))).toEqual([
      ["/star/me", "/keep"],
      ["/star/me", "/keep"],
    ]);
    expect(after?.pages.map((p) => p.recent.map((r) => r.path))).toEqual([["/other"], []]);
  });

  it("starring an already-favorited path does not duplicate the row", () => {
    const before = listing([{ dirs: 1, favorites: ["/star/me"] }]);
    const after = patchExploreFavorite(before, "/star/me", true);
    expect(after?.pages[0].favorites.map((f) => f.path)).toEqual(["/star/me"]);
  });

  it("unstars by removing from favorites only: recent is the server's recompute", () => {
    const before = listing([{ dirs: 1, favorites: ["/drop", "/keep"], recent: ["/plain"] }]);
    const after = patchExploreFavorite(before, "/drop", false);
    expect(after?.pages[0].favorites.map((f) => f.path)).toEqual(["/keep"]);
    expect(after?.pages[0].recent.map((r) => r.path)).toEqual(["/plain"]);
  });

  it("passes an empty cache through (the query has not answered yet)", () => {
    expect(patchExploreFavorite(undefined, "/any", true)).toBeUndefined();
  });

  it("starring keeps the recent entry's label: the row moves sections, its name travels", () => {
    const before: InfiniteData<ExploreResult> = {
      pageParams: [""],
      pages: [
        {
          path: "/x",
          parent: "/",
          entries: [],
          recent: [{ path: "/star/me", label: "work repo" }],
          favorites: [],
        },
      ],
    };
    const after = patchExploreFavorite(before, "/star/me", true);
    expect(after?.pages[0].favorites[0]).toEqual({ path: "/star/me", label: "work repo" });
    // And it left recent, so the name cannot show twice from two rows.
    expect(after?.pages[0].recent).toEqual([]);
  });

  it("re-starring a labeled favorite keeps the label instead of blanking it", () => {
    const before: InfiniteData<ExploreResult> = {
      pageParams: [""],
      pages: [
        {
          path: "/x",
          parent: "/",
          entries: [],
          recent: [],
          favorites: [{ path: "/star/me", label: "named repo" }],
        },
      ],
    };
    const after = patchExploreFavorite(before, "/star/me", true);
    expect(after?.pages[0].favorites).toEqual([{ path: "/star/me", label: "named repo" }]);
  });

  it("leaves the entries array alone: the walk's pages are not re-paged", () => {
    const before = listing([{ dirs: 3 }, { dirs: 4 }]);
    const after = patchExploreFavorite(before, "/star/me", true);
    expect(after?.pages.map((p) => p.entries.length)).toEqual([3, 4]);
  });
});
