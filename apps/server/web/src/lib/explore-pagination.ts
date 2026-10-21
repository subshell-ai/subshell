import type { InfiniteData } from "@tanstack/react-query";
import type { ExploreResult } from "@/types/files";

/**
 * How close the virtualizer's tail row must come to the end of the loaded
 * folders before the picker asks for another page. 20 rows is several
 * viewports of slack on the `h-56` panel: enough runway that a fast flick
 * lands on rows that are already there, small enough that the walk never
 * visibly stalls.
 */
export const EXPLORE_PREFETCH_ROWS = 20;

/** Everything the tail test reads, so the decision itself is table-testable. */
export interface NextPageCondition {
  /** The virtualizer's last visible row index, or -1 when it has no window
   *  yet (no scroller attached, or a listing of nothing). */
  lastVisibleIndex: number;
  /** Folder rows in the cache across every loaded page, files filtered out:
   *  the count the virtualizer actually renders. */
  totalLoadedDirs: number;
  /** The query still has a cursor to spend. */
  hasNextPage: boolean;
  /** A page is in flight right now. */
  isFetchingNextPage: boolean;
  /** The query's last fetch failed. */
  lastFetchFailed: boolean;
}

/**
 * Whether the picker should ask for the next page of a walked listing.
 *
 * The trigger is the tail index against the TOTAL loaded dirs, not against
 * what the newest page added, and that distinction is load-bearing: a page
 * carries dirs AND files (the server pages the raw sorted listing), so a page
 * can land with zero new dirs. When it does (and rows are loaded), the count
 * and the window are both unchanged, the answer here stays true, and the walk
 * keeps going until the cursor runs out or the listing's tail leaves the
 * margin. A trigger phrased as "new rows appeared" would stall on exactly
 * those pages.
 *
 * Two cases stop the walk on purpose. A failed page does: the query's error
 * state is sticky until some fetch succeeds, and this surface has no user
 * gesture that forces one, so re-asking would loop a dead endpoint at network
 * speed on every flag flip. The cached listing stays on screen (the picker's
 * "data first, error second" design). A navigation to a DIFFERENT path
 * re-walks under its fresh query key; returning to the SAME path reuses the
 * cached listing, failed tail and all, until something invalidates it. And a
 * listing that has rendered NO dirs at all
 * does: with zero rows `lastVisibleIndex` is -1 forever, so an empty
 * virtualizer can never leave the margin and a files-only directory (the
 * node_modules shape) would silently walk its entire cursor chain, hundreds
 * of requests, to render nothing. Page 1 never consults this predicate (the
 * infinite query fetches it on mount when enabled), so this stop cannot cost
 * a first page. The trade-off is honest: a folder sorting past page 1 of a
 * huge files-only listing needs a typed path now, and the silent 160-request
 * walk was the worse failure.
 *
 * The `lastVisibleIndex` of -1 (no window yet) still clears the test for any
 * listing WITHIN the margin: a two-folder page fetches because there is
 * nothing to scroll to in the first place.
 */
export function shouldFetchNextPage({
  lastVisibleIndex,
  totalLoadedDirs,
  hasNextPage,
  isFetchingNextPage,
  lastFetchFailed,
}: NextPageCondition): boolean {
  if (!hasNextPage || isFetchingNextPage || lastFetchFailed) return false;
  // No rendered rows means no margin to ever leave: an empty listing must not page.
  if (totalLoadedDirs === 0) return false;
  return lastVisibleIndex >= totalLoadedDirs - 1 - EXPLORE_PREFETCH_ROWS;
}

/**
 * Flip one path's favorite state inside a cached explore listing WITHOUT
 * refetching anything.
 *
 * The star mutation used to invalidate `["explore"]`, which was one refetch
 * per folder while the query was a single response; with the cursor walk it
 * became 160+ fetches to change one star on a walked 32k listing. The star
 * PATCH moves exactly two cached facts (this path's presence in `favorites`
 * and in `recent`), so this patches them in place across every loaded page;
 * the next real navigation re-reads the server's truth anyway.
 *
 * Starring prepends the favorite (newest first, matching the server's order)
 * and drops the path from `recent` (recent excludes favorites). The new row
 * carries the name the panel already showed when one is known (see
 * `retainedFavoriteLabel`), so starring never blanks a labeled row. Unstarring
 * only removes it from `favorites`: whether it falls back into `recent` is
 * the server's recompute, not something this cache can know.
 */
export function patchExploreFavorite(
  data: InfiniteData<ExploreResult> | undefined,
  path: string,
  on: boolean,
): InfiniteData<ExploreResult> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      favorites: on
        ? [{ path, label: retainedFavoriteLabel(page, path) }, ...page.favorites.filter((f) => f.path !== path)]
        : page.favorites.filter((f) => f.path !== path),
      recent: on ? page.recent.filter((r) => r.path !== path) : page.recent,
    })),
  };
}

/**
 * The label to keep when starring `path` on one page: the path's own favorite
 * row first (a re-star must not blank a named favorite), then its `recent`
 * row (the star moves the row between the two sections, and the name should
 * travel with it), then null.
 */
function retainedFavoriteLabel(page: ExploreResult, path: string): string | null {
  return page.favorites.find((f) => f.path === path)?.label ?? page.recent.find((r) => r.path === path)?.label ?? null;
}
