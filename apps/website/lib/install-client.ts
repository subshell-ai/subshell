import { detectIsMac } from "./install";
import { RAW_MANIFEST_URL, type ReleasesManifest, refreshReleases } from "./releases";

export { detectIsMac };

/** The browser-side half: the component gets its baked manifest from the
 * server render and swaps in the live one once, after mount. */
export function refreshReleasesHost(baked: ReleasesManifest): Promise<ReleasesManifest> {
  const fetchManifest = (_url: string | URL, init?: RequestInit) => fetch(RAW_MANIFEST_URL, init);
  // Cast, not a match: refreshReleases only ever calls the two-argument form;
  // the DOM fetch type carries members (preconnect) a plain lambda cannot show.
  return refreshReleases(baked, fetchManifest as unknown as typeof fetch);
}
