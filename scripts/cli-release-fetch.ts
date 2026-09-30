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

/**
 * The size ceiling for every asset downloaded here, in deliberate parity
 * with the server's `MAX_ARTIFACT_BYTES`
 * (`apps/server/api/src/services/releases.ts`): the same bytes travel the
 * other road too, and an over-large answer there is a failure, not a
 * maybe. A desktop build would otherwise stream a corrupt or replaced
 * asset into memory without limit.
 */
export const MAX_ASSET_BYTES = 300 * 1024 * 1024;

/** Attempts per lookup; then the LAST answer is returned as-is. After four
 *  tries a real problem should surface with the status the caller already
 *  prints verbatim — the retry is for the blip, not for the outage. */
const FETCH_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 2000;
/** Ceiling on a server-supplied `Retry-After`, so one absurd header cannot
 *  stall a cut on a polite wait past the job timeout. */
const MAX_WAIT_MS = 60_000;

/**
 * The "ask again" answers, per GitHub's own rate-limit contract: secondary
 * rate limiting arrives as 403/429 (often with `Retry-After`), and blips
 * arrive as 5xx. A transient mid-cut failure must not strand a 90-minute
 * desktop shard on a soft refusal. A 404 is NEVER retried — it is the
 * caller's decisive "never released" fact, and re-asking spends cut minutes
 * to learn what is already true.
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 403 || status === 429;
}

interface TransportDeps {
  /** Injectable for tests; production never passes one. */
  fetchFn?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  /** Test knob only; production uses the exported cap. */
  maxBytes?: number;
}

const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchWithTransientRetry(
  url: string,
  headers: Record<string, string>,
  deps: TransportDeps,
): Promise<Response> {
  const fetchFn = deps.fetchFn ?? fetch;
  const wait = deps.wait ?? realWait;
  let last: Response | undefined;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    const res = await fetchFn(url, { headers });
    if (!isTransientStatus(res.status)) return res;
    last = res;
    if (attempt === FETCH_ATTEMPTS - 1) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    await wait(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, MAX_WAIT_MS)
        : BASE_BACKOFF_MS * 2 ** attempt,
    );
  }
  // FETCH_ATTEMPTS >= 1 makes the loop's `last` assignment unconditional on
  // this path; the cast names the invariant rather than hiding it.
  return last as Response;
}

/**
 * Read a 200 body whole, refusing anything bigger than the cap — by the
 * declared length when the server states one, and by the ACTUAL count while
 * streaming when it does not (a lie in `content-length` buys nothing).
 * Throws rather than returning undefined, because the caller's
 * undefined-branch says "answered HTTP <status>" and 200-but-too-big is a
 * different fact that must not wear that message.
 */
async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const refuse = (why: string) => new Error(`refused: ${why} (cap ${maxBytes} bytes)`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw refuse(`the asset declares ${declared} bytes`);
  const reader = res.body?.getReader();
  if (reader === undefined) {
    // No stream to meter (an empty or synthetic body): fall back to the
    // whole-buffer read and meter the result.
    const whole = new Uint8Array(await res.arrayBuffer());
    if (whole.byteLength > maxBytes) throw refuse(`the body held ${whole.byteLength} bytes`);
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    seen += value.byteLength;
    if (seen > maxBytes) {
      await reader.cancel();
      throw refuse(`the stream passed ${seen} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(seen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface ReleaseIndex {
  /** The HTTP status the lookup answered; 404 is "this version was never released". */
  status: number;
  /** Asset name → its octet-stream download URL. Empty unless the release exists. */
  assets: Record<string, string>;
  /**
   * True when the tags endpoint answered with a DRAFT release. It does, to
   * any push-scoped token: the endpoint answers 200 for drafts, so "exists"
   * and "shipped" are different facts and the caller must not conflate them
   * (a cut that died between draft and flip would otherwise look published).
   */
  draft: boolean;
}

/** The tags endpoint's JSON → the index. Pure, so the draft rule is testable. */
export function releaseIndexFrom(
  status: number,
  body: { assets?: { name: string; url: string }[]; draft?: boolean },
): ReleaseIndex {
  const assets: Record<string, string> = {};
  // Only a 200 is a promise of contents; anything else indexes nothing.
  if (status === 200) for (const a of body.assets ?? []) assets[a.name] = a.url;
  return { status, assets, draft: body.draft === true };
}

/**
 * The release's asset index, or an empty one with the HTTP status that
 * explains its absence. Transient API answers (403/429/5xx) are retried a
 * bounded number of times first; the status finally returned is a fact the
 * caller can act on. Only a 200 is a promise of contents, and even a 200
 * may name a DRAFT (`index.draft`); distinguishing that is the caller's job.
 * Bytes only, never digests: the caller hashes the file it WROTE, so the
 * digest is computed at the point of use, not at the point of fetch.
 */
export async function fetchReleaseIndex(
  component: ReleaseComponent,
  version: string,
  deps: TransportDeps = {},
): Promise<ReleaseIndex> {
  const token = process.env.GH_TOKEN ?? "";
  if (token === "")
    throw new Error("GH_TOKEN is not set; the private repo answers 404 unauthenticated, so a fetch must never guess");
  const res = await fetchWithTransientRetry(releaseTagUrl(component, version), apiHeaders(token), deps);
  if (!res.ok) return releaseIndexFrom(res.status, {});
  return releaseIndexFrom(
    res.status,
    (await res.json()) as { assets?: { name: string; url: string }[]; draft?: boolean },
  );
}

/**
 * One asset's bytes. A non-200 is returned, not thrown: the caller names it.
 * A body bigger than {@link MAX_ASSET_BYTES} is THROWN for — it is a corrupt
 * or replaced asset, not a status the caller has words for.
 */
export async function fetchReleaseBytes(
  url: string,
  deps: TransportDeps = {},
): Promise<{ status: number; bytes: Uint8Array | undefined }> {
  const res = await fetchWithTransientRetry(url, apiHeaders(process.env.GH_TOKEN ?? "", true), deps);
  if (!res.ok) return { status: res.status, bytes: undefined };
  return { status: res.status, bytes: await readBounded(res, deps.maxBytes ?? MAX_ASSET_BYTES) };
}
