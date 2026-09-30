/**
 * Fetching a published component release's assets — the shared half of the
 * two desktop pipelines' `stageSidecar`, which embeds the CLI's OWN release
 * binary as the Tauri sidecar (cut-order ruling, 2026-09-30).
 *
 * It goes to the GitHub API over Bun's own `fetch`, NOT the `gh` CLI: the
 * linux desktop shard runs inside the desktop-builder container, which
 * carries no `gh` (and every future shard would need one more apt line in
 * the image). A cut must not depend on which image happens to run the job.
 *
 * Auth is `GH_TOKEN` — the job token the workflow exports. It is mandatory:
 * the repo is private, and an unauthenticated lookup answers 404 for a
 * release that DOES exist, which would make "not published yet" a lie.
 */

import {
  RELEASE_TAG_PREFIX,
  type ReleaseComponent,
  SUBSHELL_REPO_SLUG,
} from "../packages/subshell-protocol/src/releases.js";

/** `cli-server-v1.7.0` for ("cli-server", "1.7.0"); the prefix carries the "-v". */
export function releaseTag(component: ReleaseComponent, version: string): string {
  return `${RELEASE_TAG_PREFIX[component]}${version}`;
}

/** The tags endpoint's URL. `per_page` governs the ASSET page too. */
export function releaseTagUrl(component: ReleaseComponent, version: string): string {
  return `https://api.github.com/repos/${SUBSHELL_REPO_SLUG}/releases/tags/${releaseTag(component, version)}?per_page=100`;
}

/** GitHub's API requires a UA and versions its media types; both are fixed here. */
export function apiHeaders(token: string, octet = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: octet ? "application/octet-stream" : "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "subshell-release-fetch",
  };
}

export interface ReleaseIndex {
  /** The HTTP status the lookup answered; 404 is "this version was never released". */
  status: number;
  /** Asset name → its octet-stream download URL. Empty unless the release exists. */
  assets: Record<string, string>;
}

/**
 * The release's asset index, or an empty one with the HTTP status that
 * explains its absence. Only a 200 is a promise of contents.
 */
export async function fetchReleaseIndex(component: ReleaseComponent, version: string): Promise<ReleaseIndex> {
  const token = process.env.GH_TOKEN ?? "";
  if (token === "")
    throw new Error("GH_TOKEN is not set; the private repo answers 404 unauthenticated, so a fetch must never guess");
  const res = await fetch(releaseTagUrl(component, version), { headers: apiHeaders(token) });
  if (!res.ok) return { status: res.status, assets: {} };
  const body = (await res.json()) as { assets?: { name: string; url: string }[] };
  const assets: Record<string, string> = {};
  for (const a of body.assets ?? []) assets[a.name] = a.url;
  return { status: res.status, assets };
}

/** One asset's bytes. A non-200 is returned, not thrown: the caller names it. */
export async function fetchReleaseBytes(url: string): Promise<{ status: number; bytes: Uint8Array | undefined }> {
  const res = await fetch(url, { headers: apiHeaders(process.env.GH_TOKEN ?? "", true) });
  if (!res.ok) return { status: res.status, bytes: undefined };
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
}
