/**
 * Reading the project's releases: one list, one cache, every component.
 *
 * Generalized from `services/node-release.ts` (spec 2026-09-15 §3.3), which
 * knew only about agent binaries. What is new is that the SERVER updates itself
 * from the same list, so the index is keyed by component and the node half now
 * asks a sharper question — "which node release can THIS server talk to" rather
 * than "the newest one above the floor".
 *
 * Four rules shape this module, and each is a decision rather than a detail:
 *
 * - **Nothing is fetched until something asks for it.** There is no warm-up,
 *   no boot-time sweep, no background poll. A plane whose nodes are all
 *   linux-x64 never spends a byte on the two darwin builds, and a plane nobody
 *   enrolls against and never updates touches the network not at all. The
 *   entry points are the download routes (whose serve decision, since
 *   2026-10-09, reads the cached index on every authenticated request and
 *   pays the tiny reads at most once per TTL) and the update verb — never a
 *   routine of their own. Binary BYTES are still lazy: nothing over ~1 KB
 *   moves until a machine is actually being served — where "being served"
 *   includes the moment `POST /api/nodes/:id/update` commits to one, since
 *   2026-10-31 that route warms the bytes it is about to authorize before it
 *   sends the command, so N nodes downloading at once share one fetch and no
 *   node's download stalls on the plane's cold first read.
 * - **The bytes are downloaded IN FULL and verified before anything is
 *   served.** The old shape streamed the release through while hashing on the
 *   way past, and paid for it on 2026-10-23: the coalescer's shared live
 *   stream was already consumed for every joiner but the first, and the
 *   mid-flight error it produced was a truncated download nobody could tell
 *   from a broken network. Now {@link downloadVerified} writes the whole file
 *   to a temp path (hashing each chunk, bounded by `MAX_ARTIFACT_BYTES` as it
 *   goes), a mismatch fails the FETCH itself with the temp deleted, and the
 *   caller serves a fresh read of bytes that already passed. Nothing
 *   unverified is cached, and `install.sh` still verifies the digest itself
 *   before the first `chmod +x` — that check predates this module and stands
 *   as the node's own defense.
 * - **A file we fetched is ours to replace; a file the operator put there is
 *   not.** Cached artifacts are recorded in a manifest with the release tag
 *   they came from, and only manifest-recorded files are ever superseded or
 *   deleted. A binary published by `release:cli-node` has no manifest entry and is
 *   left alone forever.
 * - **A node release with no `release-manifest.json` is never offered.** The
 *   manifest is what says which protocol that agent speaks (spec §3.2), and
 *   handing a node a build this plane cannot talk to produces an agent that
 *   installs, reconnects and is closed 4406. Unknown is refused, by name, and
 *   the reason travels to the page.
 * - **A release is installable only if its manifest is SIGNED and the
 *   signature verifies** (spec 2026-09-17). The digest the bytes are compared
 *   against comes from the signed manifest's `assets` map, never from a
 *   `.sha256` sidecar — those stay published for `install.sh` and pre-change
 *   consumers, but no path in this module consults one. The publisher pubkey
 *   is compiled in (`RELEASE_PUBKEY`); what the release source says about a
 *   binary means nothing until the signature over the manifest says it too.
 *   Every refusal here is a reason string in the same sentence grammar the
 *   Updates page already renders, because "why is there no update" is the
 *   question the page exists to answer.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readResponseBounded } from "@internal/pane-runtime";
import {
  MIN_NODE_VERSION,
  NODE_PROTOCOL_VERSION,
  type NodeTarget,
  newestRelease,
  RELEASE_COMPONENTS,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  RELEASE_PUBKEY,
  type ReleaseCandidate,
  type ReleaseComponent,
  type ReleaseManifest,
  releaseAssetNames,
  semverLt,
} from "@internal/subshell-protocol";
import { verifyReleaseManifest } from "@internal/subshell-protocol/release-signature";
import { IS_TEST, NODE_ARTIFACTS_DIR, SUBSHELL_RELEASE_URL } from "@/constants.js";
import { artifactPath } from "@/modules/updates/node-artifacts.js";
import { getLogger } from "@/shared/logger.js";

/** How long a resolved release index is trusted before the list is read again. */
const RELEASE_TTL_MS = 15 * 60 * 1000;
/** Budget for the release list, the (tiny) sidecar and the (tiny) manifest. The binary has no deadline; it streams. */
const METADATA_TIMEOUT_MS = 15_000;
/**
 * Refuse a binary larger than this. The published builds are 70-90 MB, so the
 * cap is loose on purpose: it exists to stop a misconfigured URL streaming
 * something unbounded onto the data volume, not to police the real artifacts.
 */
export const MAX_ARTIFACT_BYTES = 300 * 1024 * 1024;

/** How old a `.download-*` stray must be before a fresh download sweeps it.
 *  One hour clears any honest download at 300 MB/s-and-change, so a stray
 *  older than this is a crashed attempt's corpse, not a live write. @internal */
export const STALE_DOWNLOAD_MAX_AGE_MS = 60 * 60 * 1000;

/** The digest-failure phrase, shared because {@link fetchVerifiedTemp}
 *  pattern-matches what {@link downloadVerified} throws to keep the artifact
 *  log line truthful. Tests pin the shipped string with a literal regex. */
const DIGEST_MISMATCH_PHRASE = "did not match the published digest";

/**
 * What this instance fetched, and from which release.
 *
 * `commit` (spec 2026-09-17 §5) is the commit the SIGNED manifest names —
 * so the lazy-fetch audit trail says what was verified, not merely what
 * arrived. Entries predating the field read it as absent, which is honest:
 * those fetches happened before the digest was a signed fact.
 */
interface FetchedManifest {
  /** Keyed by target; absent means "not ours" — an operator-published file. */
  [target: string]: { tag: string; digest: string; fetchedAt: string; commit?: string } | undefined;
}

const MANIFEST_NAME = ".fetched.json";
const manifestPath = () => join(NODE_ARTIFACTS_DIR, MANIFEST_NAME);

/**
 * The release source, or null when the operator has turned it off.
 *
 * Empty is the supported air-gapped configuration: the download routes then
 * serve only what is on disk, and `update` refuses rather than reaching out.
 */
function releaseApiUrl(): string | null {
  const url = testOverride ?? SUBSHELL_RELEASE_URL;
  return url === "" ? null : url;
}

/** Whether this instance will fetch from the release source at all. */
export function autoFetchEnabled(): boolean {
  return releaseApiUrl() !== null;
}

/** The configured source, for a view that wants to show it. `null` = disabled. */
export function releaseSourceUrl(): string | null {
  return releaseApiUrl();
}

/**
 * Point this instance at a different releases endpoint. Tests only — a
 * production process must never be redirected, so the setter refuses outside
 * a test run (the same seam `setPluginsRegistryUrlForTests` uses).
 * @internal
 */
let testOverride: string | null = null;
export function setReleaseUrlForTests(url: string | null): void {
  if (!IS_TEST) throw new Error("setReleaseUrlForTests is test-only");
  testOverride = url;
  cachedIndex = null;
  indexFailure = null;
  indexInFlight = null;
  inFlight.clear();
  purgeServePastForTests();
}

// ---------------------------------------------------------------------------
// Resolving the index
// ---------------------------------------------------------------------------

/** One release's tag, version, assets and (lazily read) manifest. */
export interface ResolvedRelease extends ReleaseCandidate {
  /** Which component this release is — the index already knows; verification asserts the manifest agrees (spec 2026-09-17 §3: the payload says what it is). */
  component: ReleaseComponent;
  /** Download URL by asset name. */
  assets: Map<string, string>;
  /**
   * The parsed `release-manifest.json`, or null when the release carries none,
   * carries an unsigned or unverifiable one, or it could not be read. Filled
   * on first use by {@link checkReleaseManifest} and memoized with the index,
   * so a page that only asks "is there a newer server" never fetches it.
   */
  manifest: ReleaseManifest | null;
  /** Whether {@link manifest} has been looked for yet. */
  manifestRead: boolean;
  /**
   * The full outcome behind {@link manifest}, memoized with it — the three
   * refusals are one `null` to the parser but three DIFFERENT sentences to
   * the page that has to explain why there is no update.
   */
  manifestOutcome: ManifestOutcome | null;
}

/** The signed manifest of one release, as {@link checkReleaseManifest} verified it. */
export interface VerifiedReleaseManifest {
  /** Parsed from the exact verified bytes — never re-serialized before parsing (§3). */
  manifest: ReleaseManifest;
  /** The exact published manifest text — what the signature covers. */
  bytes: string;
  /** The published `release-manifest.json.sig` armor, verbatim. */
  sig: string;
}

/**
 * The result of reading AND verifying one release's manifest.
 *
 * Three refusals, one per distinct sentence the Updates page renders: no
 * manifest at all (every cut before 2026-09-15), a manifest nobody signed
 * (every cut between then and the signing pipeline landing), and a signature
 * that failed (the active-attack-shaped one). One `null` would tell the
 * operator "no manifest" when the truth is "someone handed you a bad
 * signature" — the wrong story about an incident.
 */
export type ManifestOutcome =
  | { kind: "ok"; verified: VerifiedReleaseManifest }
  | { kind: "no-manifest" }
  | { kind: "unsigned" }
  | { kind: "failed"; reason: string };

/** Every component's newest published release, as of one read of the list. */
export interface ReleaseIndex {
  byComponent: Record<ReleaseComponent, ResolvedRelease | null>;
  /** When the list was read (epoch ms), so a view can say how stale it is. */
  checkedAt: number;
}

let cachedIndex: { at: number; index: ReleaseIndex } | null = null;
/** Why the last index read failed and until when to not repeat it; see {@link resolveReleases}. */
let indexFailure: { message: string; until: number } | null = null;
/**
 * The one in-flight index read, shared by every caller who arrives while it
 * runs. Without it the memo answers nobody in the burst: "Update all" fires
 * every POST's release lookup at once, each with a cold cache, each opening
 * its own GitHub request and its own copy of the index — a metadata burst
 * against an unauthenticated API, and N divergent `ResolvedRelease` objects
 * whose manifest memoizations cannot see each other.
 */
let indexInFlight: Promise<ReleaseIndex> | null = null;
/** How long a failed index read is remembered. */
const INDEX_BACKOFF_MS = 60_000;

/** The shape of the releases list this reads. Everything else in the payload is ignored. */
interface ReleasePayload {
  tag_name?: unknown;
  draft?: unknown;
  assets?: unknown;
  published_at?: unknown;
}

/** Published-at by tag, kept beside the index for the Updates page's "when". */
const publishedAt = new Map<string, string>();

/** When a release was published, as the API reported it; `null` when unknown. */
export function releasePublishedAt(tag: string): string | null {
  return publishedAt.get(tag) ?? null;
}

/**
 * The newest release of EVERY component, memoized for {@link RELEASE_TTL_MS}.
 *
 * Drafts are skipped: the release pipeline publishes draft-then-live, so a cut
 * in flight is visible to a token that can see drafts and must not be handed to
 * anyone. Unlike the pre-2026-09-15 `resolveRelease`, nothing is refused HERE
 * for being too old — this is the index, and each consumer applies its own
 * question to it ({@link compatibleNodeRelease} for nodes, a version compare
 * for the server).
 */
export async function resolveReleases(): Promise<ReleaseIndex> {
  const api = releaseApiUrl();
  if (api === null) throw new Error("this server does not fetch releases (SUBSHELL_RELEASE_URL is empty)");
  const now = Date.now();
  if (cachedIndex && now - cachedIndex.at < RELEASE_TTL_MS) return cachedIndex.index;
  // A failed read is remembered for a minute (see {@link indexFailure}): since
  // 2026-10-09 the download routes consult the release on EVERY authenticated
  // request, and without the backoff a no-egress plane would pay the full
  // metadata timeout per install instead of per minute.
  if (indexFailure !== null && now < indexFailure.until) throw new Error(indexFailure.message);
  // Burst callers join the read that is already running (see
  // {@link indexInFlight}): the memo cannot answer them because nothing has
  // settled yet, which is how a single "Update all" became one API request
  // per POST.
  indexInFlight ??= resolveReleasesUncached(api).finally(() => {
    indexInFlight = null;
  });
  return indexInFlight;
}

async function resolveReleasesUncached(api: string): Promise<ReleaseIndex> {
  const now = Date.now();
  let payload: unknown;
  try {
    const response = await fetch(api, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${api} answered ${response.status}`);
    payload = JSON.parse(new TextDecoder().decode(await readResponseBounded(response, 8 * 1024 * 1024)));
  } catch (error) {
    // Every failure names the URL it tried, the way the registry client does:
    // "could not reach the release source" with no address is unactionable.
    const message = `could not read the releases from ${api}: ${error instanceof Error ? error.message : error}`;
    indexFailure = { message, until: Date.now() + INDEX_BACKOFF_MS };
    throw new Error(message);
  }
  if (!Array.isArray(payload)) {
    const message = `${api} did not answer a list of releases`;
    indexFailure = { message, until: Date.now() + INDEX_BACKOFF_MS };
    throw new Error(message);
  }

  const byTag = new Map<string, Map<string, string>>();
  for (const entry of payload as ReleasePayload[]) {
    if (entry.draft === true) continue;
    const tag = typeof entry.tag_name === "string" ? entry.tag_name : null;
    if (tag === null) continue;
    const assets = new Map<string, string>();
    for (const asset of Array.isArray(entry.assets) ? entry.assets : []) {
      const { name, browser_download_url: url } = (asset ?? {}) as { name?: unknown; browser_download_url?: unknown };
      if (typeof name === "string" && typeof url === "string") assets.set(name, url);
    }
    byTag.set(tag, assets);
    if (typeof entry.published_at === "string") publishedAt.set(tag, entry.published_at);
  }

  const tags = [...byTag.keys()];
  const byComponent = {} as Record<ReleaseComponent, ResolvedRelease | null>;
  for (const component of RELEASE_COMPONENTS) {
    const newest = newestRelease(component, tags);
    byComponent[component] =
      newest === null
        ? null
        : {
            ...newest,
            component,
            assets: byTag.get(newest.tag) ?? new Map(),
            manifest: null,
            manifestRead: false,
            manifestOutcome: null,
          };
  }

  const index: ReleaseIndex = { byComponent, checkedAt: now };
  cachedIndex = { at: now, index };
  indexFailure = null;
  return index;
}

/**
 * Drop the memoized index so the next read reaches the network — the Re-check
 * button, and the CLI's `update --check`.
 *
 * A read that is already in flight answers this one too: the join
 * ({@link resolveReleases}) is deliberately unconditional, so a click that
 * lands during a burst's fetch gets those bytes a moment later rather than
 * opening a second GitHub request. The list is a cache by contract; the click
 * proves eagerness to ask, not a demand to ask twice.
 */
export async function refreshReleases(): Promise<ReleaseIndex> {
  cachedIndex = null;
  indexFailure = null; // an explicit re-check outranks the backoff
  return resolveReleases();
}

/**
 * Test seam for the publisher verification (spec 2026-09-17). Tests stand in
 * for the cryptographic half — the verifier's own correctness against real
 * `tauri signer` output is pinned in the protocol package's fixture tests,
 * and end-to-end against a live signed cut by `published-release.sh`.
 * @internal
 */
export const releaseSeams = {
  verifyManifest: verifyReleaseManifest,
};

// ---------------------------------------------------------------------------
// Egress pinning (round-3 sweep C12, 2026-09-24)
// ---------------------------------------------------------------------------

/**
 * The hosts this module may fetch release bytes FROM, beyond the one host the
 * operator configured as the source itself.
 *
 * The shipped default IS GitHub (`SUBSHELL_RELEASE_URL` defaults to
 * `DEFAULT_RELEASE_API` on api.github.com, and a GitHub release asset's
 * `browser_download_url` is github.com, which redirects to the asset host),
 * so for the default configuration the list
 * is trivially "GitHub plus what the operator configured" — and that is the
 * point. The list exists for the OTHER configuration: an operator pointing
 * `SUBSHELL_RELEASE_URL` at a mirror of their own. The mirror then chooses
 * every `browser_download_url` the plane is asked to fetch, and without this
 * list it could point this process's egress at link-local internals
 * (169.254.169.254 and friends). The signed manifest already decides WHAT may
 * run (§11.12); this decides WHERE the plane will knock.
 *
 * `raw.githubusercontent.com` is deliberately ABSENT: no release asset URL
 * this pipeline publishes is served from there (assets live on github.com and
 * redirect to the renamed asset host), and an allowlist entry nothing
 * uses is an egress door held open for no one.
 *
 * What the pin gates (C12, extended by the 2026-09-24 review): the URL the
 * source named AND every hop it redirects to. That second clause is what
 * makes the claim true — byte-trust is not egress-trust. Bun's `fetch`
 * follows 302s by default, so gating only the first URL left every
 * source-named fetch one redirect away from anywhere on the planet: the
 * mirror can serve an on-list URL that answers 302 → 169.254.169.254, and
 * the pin as originally written waved it through. The module therefore
 * fetches with `redirect: "manual"` and walks the chain itself
 * ({@link fetchWithPinnedEgress}), re-running this predicate on each
 * `Location` before fetching it, bounded by {@link MAX_REDIRECT_HOPS}. The
 * list fetch in {@link resolveReleases} is the one exempt read, and the
 * exemption is structural: its URL is the string the OPERATOR configured,
 * not a field the source publishes.
 */
const ALLOWED_FETCH_HOSTS: ReadonlySet<string> = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

/** A fetch the release egress allowlist refuses. Carries the rejected host. */
export class ReleaseFetchHostRefused extends Error {
  /** The host that was refused, lowercase, exactly as the URL named it. */
  readonly host: string;

  constructor(host: string) {
    super(`${host} is neither a GitHub release host nor the configured release source's host`);
    this.name = "ReleaseFetchHostRefused";
    this.host = host;
  }
}

/**
 * Whether `url` names an origin this module may fetch from: a GitHub release
 * host, or the exact origin of the configured `SUBSHELL_RELEASE_URL`. The
 * list-fetch itself always targets the configured source, so this is the
 * guard on everything the list points at — binaries, manifests, signatures,
 * and every redirect hop between those URLs and the bytes.
 *
 * An unparsable URL is refused, never fetched. A disabled source allows
 * nothing beyond GitHub's hosts — nothing in the module reaches this with a
 * disabled source (every entry point refuses first), and the belt costs one
 * comparison.
 */
export function releaseFetchAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (ALLOWED_FETCH_HOSTS.has(host)) return true;
  const api = releaseApiUrl();
  if (api === null) return false;
  try {
    return parsed.origin === new URL(api).origin;
  } catch {
    return false;
  }
}

/** The named refusal every fetch of source-named bytes passes through. */
function assertReleaseFetchAllowed(url: string): void {
  if (releaseFetchAllowed(url)) return;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* the raw value is the most honest host-shaped thing there is */
  }
  const error = new ReleaseFetchHostRefused(host);
  getLogger().warn(`release egress refused: ${error.message}`);
  throw error;
}

/**
 * Redirect hops {@link fetchWithPinnedEgress} will walk for one source-named
 * URL. A GitHub asset is ONE hop (github.com → the asset host),
 * so five is headroom for any honest chain and short enough that an endless
 * loop fails the fetch rather than hanging the caller — the same reasoning as
 * {@link METADATA_TIMEOUT_MS} applied to hops instead of seconds.
 */
export const MAX_REDIRECT_HOPS = 5;

/** Statuses the Fetch spec defines as redirects (300 and 304 are not one). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a URL the release source named, re-pinning EVERY hop of the chain.
 *
 * This is the module's only fetch of source-named bytes, and it exists
 * because the default `redirect: "follow"` made {@link releaseFetchAllowed}
 * a check of the first hop only: an allowlisted mirror answers `302 →
 * http://169.254.169.254/...` and Bun would have walked straight there.
 * `redirect: "manual"` hands each hop's response back, and the loop re-runs
 * the pin on every `Location` before fetching it. A `Location` that cannot
 * be resolved against the current hop is refused (unfollowable is
 * unchecked), and a chain longer than {@link MAX_REDIRECT_HOPS} is refused
 * rather than followed. A redirect status with NO `Location` header is not a
 * redirect by the spec's definition — it is returned to the caller, whose
 * `!response.ok` check turns it into the ordinary "answered 30x" error.
 */
async function fetchWithPinnedEgress(url: string, init?: RequestInit): Promise<Response> {
  let target = url;
  for (let hop = 0; ; hop++) {
    assertReleaseFetchAllowed(target);
    const response = await fetch(target, { ...init, redirect: "manual" });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (location === null) return response;
    // The hop's body is not this fetch's answer; release the connection
    // before walking on, whatever happens to the hop count.
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new Error(`${url} redirected more than ${MAX_REDIRECT_HOPS} times`);
    }
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new Error(`${target} named an unparseable redirect target`);
    }
    target = next.href;
  }
}

/**
 * That release's `release-manifest.json` AND its signature: fetched once,
 * verified once, memoized on the index entry.
 *
 * Fetching and verifying live in one function because splitting them is how
 * a caller ends up parsing a manifest it never checked — the canonical-bytes
 * rule (§3) only holds if the bytes flow from fetch to `verifyReleaseManifest`
 * to `parseReleaseManifest` without an intervening re-serialization.
 *
 * An unreachable manifest or signature reads `failed` with the transport
 * reason — "could not read" and "refused to verify" share the consequence
 * (do not offer) and differ only in the sentence; neither is a page failure.
 */
const manifestInFlight = new WeakMap<ResolvedRelease, Promise<ManifestOutcome>>();

export async function checkReleaseManifest(release: ResolvedRelease): Promise<ManifestOutcome> {
  if (release.manifestRead && release.manifestOutcome !== null) return release.manifestOutcome;
  // Join the check already running for THIS release object. The memo above
  // can only answer a SETTLED read, and every POST of an "Update all" checks
  // the same release object while the first pair of tiny reads is still in
  // flight — without this the burst pays N manifest reads and N signatures
  // regardless of the index being shared.
  const running = manifestInFlight.get(release);
  if (running !== undefined) return running;
  const work = checkReleaseManifestUncached(release).finally(() => manifestInFlight.delete(release));
  manifestInFlight.set(release, work);
  return work;
}

async function checkReleaseManifestUncached(release: ResolvedRelease): Promise<ManifestOutcome> {
  release.manifestRead = true;
  const manifestUrl = release.assets.get(RELEASE_MANIFEST_NAME);
  if (manifestUrl === undefined) return remember(release, { kind: "no-manifest" });
  const sigUrl = release.assets.get(RELEASE_MANIFEST_SIG_NAME);
  if (sigUrl === undefined) return remember(release, { kind: "unsigned" });
  try {
    // The tiny reads get the SAME egress pin as the 80 MB one, hop for hop —
    // a manifest hosted off-list, or redirecting off-list, is refused before
    // it can name a digest (C12). The throw lands in the `failed` arm below
    // like any unreachable manifest: the release is not offered, and the
    // reason names the host.
    const [manifestRes, sigRes] = await Promise.all([
      fetchWithPinnedEgress(manifestUrl, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }),
      fetchWithPinnedEgress(sigUrl, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }),
    ]);
    if (!manifestRes.ok)
      return remember(release, { kind: "failed", reason: `${RELEASE_MANIFEST_NAME} answered ${manifestRes.status}` });
    if (!sigRes.ok)
      return remember(release, { kind: "failed", reason: `${RELEASE_MANIFEST_SIG_NAME} answered ${sigRes.status}` });
    const [manifestBody, signatureBody] = await Promise.all([
      readResponseBounded(manifestRes, 1024 * 1024),
      readResponseBounded(sigRes, 64 * 1024),
    ]);
    const bytes = new TextDecoder().decode(manifestBody);
    const sig = new TextDecoder().decode(signatureBody);
    const checked = await releaseSeams.verifyManifest(bytes, sig, RELEASE_PUBKEY, {
      component: release.component,
      version: release.version,
    });
    if (!checked.ok) return remember(release, { kind: "failed", reason: checked.reason });
    // The manifest the VERIFIER parsed, from the exact bytes it verified —
    // re-parsing a re-serialization would be the canonical-bytes mistake in
    // miniature (§3).
    return remember(release, { kind: "ok", verified: { manifest: checked.manifest, bytes, sig } });
  } catch (error) {
    // An unreachable manifest is an unknown release, not a failed page.
    return remember(release, { kind: "failed", reason: error instanceof Error ? error.message : String(error) });
  }
}

function remember(release: ResolvedRelease, outcome: ManifestOutcome): ManifestOutcome {
  release.manifestOutcome = outcome;
  release.manifest = outcome.kind === "ok" ? outcome.verified.manifest : null;
  return outcome;
}

/**
 * The signed digest a release's manifest names for one published filename, or
 * a throw naming why there is none. The ONLY way to ask "what should these
 * bytes hash to" anywhere an update is about to happen — every caller used to
 * read a `.sha256` sidecar, and the sidecar stopped being a trust anchor when
 * the signed manifest became one (spec 2026-09-17 §4).
 */
export async function signedAssetDigest(release: ResolvedRelease, assetName: string): Promise<string> {
  const outcome = await checkReleaseManifest(release);
  if (outcome.kind !== "ok") {
    throw new Error(
      `release ${release.tag} has no verifiable manifest (${outcome.kind === "failed" ? outcome.reason : `the release carries ${outcome.kind === "unsigned" ? "an unsigned" : "no"} manifest`})`,
    );
  }
  const digest = outcome.verified.manifest.assets[assetName];
  if (digest === undefined) throw new Error(`${release.tag}'s signed manifest names no ${assetName}`);
  return digest;
}

/** The newest node release this server can talk to, or why there is none. */
export interface CompatibleNodeRelease {
  release: ResolvedRelease | null;
  /** Why `release` is null, in one sentence a page renders verbatim; `null` when it is not. */
  reason: string | null;
  /**
   * The VERIFIED manifest + signature for `release` (present exactly when
   * `release` is not null) — what {@link checkReleaseManifest} already
   * fetched and confirmed, so the update route can put `manifest` and
   * `manifestSig` into the wire command without a second fetch (spec
   * 2026-09-17 §6). Held rather than re-derived: the bytes must be exactly
   * what was verified.
   */
  manifest: VerifiedReleaseManifest | null;
}

/**
 * The node release this plane may hand a machine.
 *
 * "Newest above the floor" was the old rule and it had a real hazard: a plane
 * one version behind would install an agent speaking a protocol it does not,
 * and that node enrolls, reconnects, and is closed 4406 forever. The manifest
 * (spec §3.2) is what makes the sharper question answerable without
 * downloading a binary — so the release offered is the newest `cli-node`
 * release whose manifest's `nodeProtocol` EQUALS this server's, and whose version
 * clears `MIN_NODE_VERSION`.
 *
 * Only the newest is considered, deliberately: walking back through older
 * releases looking for a protocol match would hand a machine a build nobody
 * cut for it, and the honest answer when the newest does not fit is "update the
 * server first".
 *
 * Since spec 2026-09-17 the manifest must also CARRY A VALID PUBLISHER
 * SIGNATURE: an unsigned release, or one whose signature does not verify, is
 * not offered either, with its own sentence — "no manifest", "no signature"
 * and "bad signature" are three different stories for the operator, and
 * guessing which would be the exact failure this whole change removes.
 */
export async function compatibleNodeRelease(): Promise<CompatibleNodeRelease> {
  const index = await resolveReleases();
  const release = index.byComponent["cli-node"];
  if (release === null)
    return { release: null, reason: "the release source publishes no cli-node-v* release", manifest: null };
  if (semverLt(release.version, MIN_NODE_VERSION)) {
    return {
      release: null,
      manifest: null,
      reason: `the newest node release (${release.tag}) is older than this server's minimum node version ${MIN_NODE_VERSION}`,
    };
  }
  const outcome = await checkReleaseManifest(release);
  if (outcome.kind === "no-manifest") {
    return {
      release: null,
      manifest: null,
      reason: `node release ${release.version} carries no release manifest, so this server cannot tell whether it speaks protocol ${NODE_PROTOCOL_VERSION}`,
    };
  }
  if (outcome.kind === "unsigned") {
    return {
      release: null,
      manifest: null,
      reason: `node release ${release.version} carries a manifest no publisher signature covers, so this server will not offer it`,
    };
  }
  if (outcome.kind === "failed") {
    return {
      release: null,
      manifest: null,
      reason: `node release ${release.version}'s manifest signature failed to verify, so this server will not offer it`,
    };
  }
  const manifest = outcome.verified.manifest;
  if (manifest.nodeProtocol !== NODE_PROTOCOL_VERSION) {
    return {
      release: null,
      manifest: null,
      reason: `newest node release ${release.version} speaks protocol ${manifest.nodeProtocol}; this server speaks ${NODE_PROTOCOL_VERSION}, so update the server first`,
    };
  }
  return { release, reason: null, manifest: outcome.verified };
}

/** A component's newest release and whether this instance may install it. */
export type CliReleaseCheck =
  | { ok: true; release: ResolvedRelease; verified: VerifiedReleaseManifest }
  | { ok: false; reason: string };

/**
 * The newest release of a self-updating CLI component that this instance may
 * actually install: it exists AND its manifest signature verifies (spec
 * 2026-09-17 §5 path 4). One function so the dashboard's Server row, the
 * dashboard's update POST and `subshell-server update` answer "what can I
 * install" with the same sentence rather than three near-identical ones —
 * the same reason `applyConfig` is the one writer of config.env.
 *
 * `cli-node` is here for completeness, but the node question is sharper than this
 * — a plane must also match protocol and floor — so anything offering a
 * release TO A NODE uses {@link compatibleNodeRelease} instead.
 */
export async function installableCliRelease(component: "cli-server" | "cli-node"): Promise<CliReleaseCheck> {
  let index: ReleaseIndex;
  try {
    index = await resolveReleases();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const release = index.byComponent[component];
  if (release === null) {
    return { ok: false, reason: `the release source publishes no ${component}-v* release` };
  }
  const outcome = await checkReleaseManifest(release);
  switch (outcome.kind) {
    case "ok":
      return { ok: true, release, verified: outcome.verified };
    case "no-manifest":
      return {
        ok: false,
        reason: `the newest ${component} release (${release.version}) carries no release manifest, so this server cannot verify it`,
      };
    case "unsigned":
      return {
        ok: false,
        reason: `the newest ${component} release (${release.version}) carries a manifest no publisher signature covers, so this server will not install it`,
      };
    case "failed":
      return {
        ok: false,
        reason: `the newest ${component} release (${release.version})'s manifest signature failed to verify, so this server will not install it`,
      };
  }
}

/**
 * The node release to serve from AND its verified manifest, or a throw naming
 * why there is none.
 *
 * The manifest cannot be null when the release is not: a release only becomes
 * `compatibleNodeRelease`'s answer once its signature verified, so this
 * asserts the invariant rather than letting every caller re-open the question
 * "but did we check the signature" — the type says the pair arrives together
 * or not at all.
 */
async function compatibleNodeReleaseOrThrow(): Promise<{
  release: ResolvedRelease;
  manifest: VerifiedReleaseManifest;
}> {
  const { release, reason, manifest } = await compatibleNodeRelease();
  if (release === null || manifest === null) throw new Error(reason ?? "no node release can be offered");
  return { release, manifest };
}

// ---------------------------------------------------------------------------
// The manifest: what we fetched, and what is therefore ours to remove
// ---------------------------------------------------------------------------

async function readManifest(): Promise<FetchedManifest> {
  try {
    const text = await Bun.file(manifestPath()).text();
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as FetchedManifest) : {};
  } catch {
    // Absent or unreadable means "we have fetched nothing", which is the safe
    // reading: every file on disk is then the operator's and untouchable.
    return {};
  }
}

async function writeManifest(manifest: FetchedManifest): Promise<void> {
  const tmp = `${manifestPath()}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(tmp, manifestPath());
}

/**
 * What this instance recorded fetching for a target, or null when the ledger
 * knows nothing about it.
 *
 * The recorded digest is the whole point: a caller compares it against the
 * bytes ACTUALLY on disk, and only a match makes the file "ours" — something
 * this instance may replace. An operator who edited the file since our fetch
 * (or who put it there) reclaimed it, and the serve-past rule of the update
 * route applies: serve the release from its own temp copy, leave the bytes
 * alone.
 */
export async function fetchedLedgerEntry(target: NodeTarget): Promise<{ tag: string; digest: string } | null> {
  const entry = (await readManifest())[target];
  return entry ? { tag: entry.tag, digest: entry.digest } : null;
}

/**
 * Delete cached binaries that came from an older release than `tag`.
 *
 * This is the whole of "remove older binaries", and it runs where the
 * information arrives: the moment we resolve a release in order to fetch
 * something, we learn which tag is current, and any file we recorded against
 * an older one is superseded. It is deleted rather than refreshed, because
 * refreshing would download a platform nobody has asked for — the file comes
 * back the next time a machine of that platform enrolls, which is the same
 * laziness the rest of this module keeps.
 *
 * Only manifest-recorded files are touched. A binary an operator published
 * with `release:cli-node` has no entry and is never removed, whatever its age:
 * this instance did not put it there and cannot know what it is.
 */
async function supersede(tag: string): Promise<void> {
  const manifest = await readManifest();
  let changed = false;
  for (const [target, entry] of Object.entries(manifest)) {
    if (!entry || entry.tag === tag) continue;
    try {
      await rm(join(NODE_ARTIFACTS_DIR, `subshell-node-cli-${target}`), { force: true });
      await rm(join(NODE_ARTIFACTS_DIR, `subshell-node-cli-${target}.sha256`), { force: true });
    } catch {
      // A file we cannot remove is not a reason to fail the fetch that is
      // about to happen; it stays recorded and is retried next time.
      continue;
    }
    delete manifest[target];
    changed = true;
    getLogger().info(`node artifacts: removed the superseded ${target} binary (${entry.tag} → ${tag})`);
  }
  if (changed) await writeManifest(manifest);
}

/**
 * Record a freshly verified artifact as ours.
 *
 * `commit` names the commit the SIGNED manifest carried (spec 2026-09-17
 * §5): the audit trail then says what was verified, not merely which tag was
 * current when bytes arrived.
 */
async function record(target: NodeTarget, tag: string, digest: string, commit: string): Promise<void> {
  const manifest = await readManifest();
  manifest[target] = { tag, digest, fetchedAt: new Date().toISOString(), commit };
  await writeManifest(manifest);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * In-flight fetches, so two enrollments of one platform download once. The
 * promise resolves only once the bytes are COMPLETE on disk, which is what
 * makes the shared value shareable: see {@link FetchedArtifact} for why an
 * earlier shape that resolved a live stream early broke exactly one use of
 * this map.
 */
const inFlight = new Map<NodeTarget, Promise<FetchedArtifact>>();

/** A verified artifact resting on disk: the bytes to serve, and what they are. */
export interface FetchedArtifact {
  digest: string;
  tag: string;
  /**
   * A response body for ONE caller. Every call opens its own read of the
   * verified bytes, so coalesced callers each get a live body. There is
   * deliberately no `stream` property to hold: a ReadableStream can be
   * consumed exactly once, and the "Update all" incident of 2026-10-23 was
   * the coalesced fetch handing one to N concurrent downloads — the first
   * node's update ran, every joiner's wrapped a dead body and its node
   * reported a download failure.
   */
  body(): ReadableStream<Uint8Array>;
  /**
   * Give up this handle. A cached artifact's dispose removes nothing (a
   * cached release is the shelf's own); a serve-past handle's releases its
   * reference on the shared temp copy — the copy itself belongs to the lease,
   * which keeps it briefly for downloads still arriving and removes it when
   * the last reader is gone and the hold window has passed.
   */
  dispose(): Promise<void>;
}

/** Options for {@link fetchArtifact}. */
export interface FetchArtifactOptions {
  /**
   * Whether the verified bytes are also CACHED into the artifacts directory
   * (default true). A caller that found a DIFFERENT file already at the
   * target's path passes false: that file may be the operator's
   * hand-published binary, and "a file we fetched is ours to replace; a file
   * the operator put there is not" holds even when the fetch is happening on
   * an update's behalf. The bytes are still fully verified either way; only
   * the writing differs. `false` fetches still share work — see
   * {@link acquireServePast} for the held-temp-copy shape that replaced the
   * original deliberately-unshared one.
   */
  cache?: boolean;
  /**
   * Bounds the wait by ABORTING the fetch (the update route's warm step
   * passes `AbortSignal.timeout()` so a plane whose link is slow says so in
   * its own 409 rather than hanging the POST). One honest consequence of
   * coalescing: a caller who JOINS a fetch inherits that fetch's abort,
   * because it is genuinely the same request. The update route accepts this
   * — every warm POST uses the same bound, and the download route's token
   * path passes no signal, so the node-driven fetch is never the one a
   * plane-side timer kills.
   */
  signal?: AbortSignal;
}

/**
 * Fetch one platform's agent binary, verify it in full, and hand the caller a
 * fresh read of the verified bytes.
 *
 * The expected digest comes from the release's SIGNED manifest (spec
 * 2026-09-17 §5 path 3) — verified before the first binary byte is fetched,
 * because the manifest and its signature are two tiny reads and having the
 * publisher's word before the 80 MB is what lets these bytes be cached at all.
 * A release whose signature does not verify gets NO bytes and NO cache entry;
 * the downloads route's 404 is unchanged from the outside, and `install.sh`'s
 * own digest check now sits behind a signature check rather than beside a
 * same-source sidecar.
 *
 * Coalescing: concurrent callers of one target SHARE the download. The
 * in-flight promise resolves only when the bytes are complete and verified on
 * disk, so every joiner receives the same {@link FetchedArtifact} and opens
 * its own body from it. The download-before-serve order costs the first
 * caller's first byte (it now waits for the plane's full fetch from the
 * release source) and buys the whole fan-out case: see the incident note on
 * {@link FetchedArtifact}. `cache: false` shares too — through the held
 * serve-past copy of {@link acquireServePast}, which replaced the original
 * one-fetch-per-caller shape that made an "Update all" against an
 * operator-published shelf cost N × ~80 MB of upstream bytes (2026-10-31).
 * The two arms still never join EACH OTHER: a cached fetch renames onto the
 * shelf path, a serve-past fetch renames nothing, and one caller's cleanup
 * must not reach another's bytes.
 */
export async function fetchArtifact(target: NodeTarget, options: FetchArtifactOptions = {}): Promise<FetchedArtifact> {
  if (options.cache === false) return acquireServePast(target, options.signal);
  const existing = inFlight.get(target);
  if (existing) {
    // A failed fetch is NOT sticky for its joiners. The settled attempt is
    // deleted from the map the moment it rejects, but callers who joined it
    // mid-flight were handed that same promise, and without a retry one
    // failed read rejects every download already coalesced onto that
    // attempt. A joiner whose attempt failed retries
    // once onto whatever newer attempt is running (or starts one), which is
    // what the route's "press Update again" copy promises the operator.
    try {
      return await existing;
    } catch {
      const retry = inFlight.get(target);
      if (retry !== undefined && retry !== existing) return retry;
    }
  }
  const work = fetchAndCacheArtifact(target, options.signal).finally(() => inFlight.delete(target));
  inFlight.set(target, work);
  return work;
}

/**
 * Fetch the release's verified bytes for one target into a temp file.
 *
 * The shared engine of both arms: {@link fetchAndCacheArtifact} renames the
 * temp onto the shelf path when the bytes are ours to cache, and the
 * serve-past lease ({@link acquireServePast}) holds it as a temp instead.
 */
async function fetchVerifiedTemp(target: NodeTarget, signal?: AbortSignal): Promise<ServePastBytes> {
  const { release, manifest } = await compatibleNodeReleaseOrThrow();
  // Resolving told us which tag is current, so this is the moment anything
  // older becomes removable. Before the download, so a plane low on disk
  // reclaims before it spends.
  await supersede(release.tag);

  const names = releaseAssetNames("cli-node", target);
  const binaryUrl = release.assets.get(names.binary);
  if (!binaryUrl) {
    throw new Error(`${release.tag} publishes no ${names.binary} — this platform is not in that release`);
  }
  // The digest the PUBLISHER signed for this exact filename. `release` only
  // came back from `compatibleNodeRelease` because this manifest verified,
  // so `manifest` is present; asking the signed map rather than re-reading a
  // sidecar is the whole of D2.
  const expected = manifest?.manifest.assets[names.binary];
  if (expected === undefined) {
    throw new Error(`${release.tag}'s signed manifest names no ${names.binary}`);
  }

  // The directory is this module's ONE production creator. Nothing else ever
  // makes it — not boot, not the publish scripts on this host — so an instance
  // that has never had `release:cli-node` run into its data dir died right here
  // on `writer()` with ENOENT, and the node's download answered 404 with the
  // plane's own filesystem named as nothing. Measured on mac-builder
  // 2026-09-20; every test green the whole time because every test fixture
  // created the directory itself. It is created for BOTH fetch shapes: the
  // cached rename needs it, and so does the temp file the serve-past lease is
  // written to before it is served.
  await mkdir(NODE_ARTIFACTS_DIR, { recursive: true });

  // Download in full, hash as it goes, refuse a mismatch. All of that, plus
  // the C12 pinned egress (the release source's `browser_download_url` may
  // name any host, and an off-list URL or hop is refused before the
  // connection) and the size cap, lives inside `downloadVerified` — the same
  // discipline the server's own update download runs, beside the caller that
  // EXECUTES the bytes. The fetch used to stream through while hashing and
  // error the response at end of body; see the FetchedArtifact note for what
  // that shared-stream shape cost.
  let tmp: string;
  try {
    tmp = await downloadVerified({
      url: binaryUrl,
      expectedDigest: expected,
      destDir: NODE_ARTIFACTS_DIR,
      destName: `subshell-node-cli-${target}.fetch`,
      signal,
    });
  } catch (error) {
    // Keep the digest failure in the artifact log line the streaming design
    // emitted: the release identity lives here, and `downloadVerified` is
    // release-agnostic by contract.
    if (error instanceof Error && error.message.includes(DIGEST_MISMATCH_PHRASE)) {
      getLogger().warn(`node artifacts: ${names.binary} from ${release.tag} failed its digest check: ${error.message}`);
    }
    throw error;
  }

  return { digest: expected, tag: release.tag, tmp, commit: manifest.manifest.commit, assetName: names.binary };
}

/** The verified-but-not-yet-placed bytes of one target, from {@link fetchVerifiedTemp}. */
interface ServePastBytes {
  digest: string;
  tag: string;
  /** Absolute path of the temp file holding the verified bytes. */
  tmp: string;
  /** The commit the SIGNED manifest names, for the cache ledger. */
  commit: string;
  /** The published asset name, for the log lines that name which file. */
  assetName: string;
}

/** The cached arm: rename onto the shelf, announce, record, serve from the shelf. */
async function fetchAndCacheArtifact(target: NodeTarget, signal?: AbortSignal): Promise<FetchedArtifact> {
  const bytes = await fetchVerifiedTemp(target, signal);
  await rename(bytes.tmp, artifactPath(target));
  // The sidecar is written from the MANIFEST's digest, not the other way
  // round: `install.sh` keeps reading the file, it just no longer decides
  // anything (spec 2026-09-17 §4).
  await writeFile(`${artifactPath(target)}.sha256`, `${bytes.digest}\n`);
  await record(target, bytes.tag, bytes.digest, bytes.commit);
  getLogger().info(`node artifacts: cached ${bytes.assetName} from ${bytes.tag}`);
  const file = Bun.file(artifactPath(target));
  return { digest: bytes.digest, tag: bytes.tag, body: () => file.stream(), dispose: async () => {} };
}

// ---------------------------------------------------------------------------
// The serve-past lease: one temp copy, many readers
// ---------------------------------------------------------------------------

/**
 * How long a fully-released serve-past copy waits before its temp is removed.
 *
 * The hold is what lets the warm-before-command shape work: the update POST
 * fetches the bytes, lets its own handle go, and only then sends the order;
 * the node's GET arrives seconds (or a redial) later and must find the
 * settled copy rather than trigger a fresh fetch. The window is bounded so a
 * batch that never showed up cannot park ~80 MB on the data volume forever. A
 * copy left past the window (a crashed process, or a ref leaked by a response
 * that never streamed) is reaped by {@link sweepStaleDownloads} like any stray
 * download; the join's re-stat then retires the now-empty slot, so the sweep
 * of the file also heals the map rather than leaving it to hand a dead path.
 */
export const SERVE_PAST_HOLD_MS = 10 * 60 * 1000;
let servePastHoldMs = SERVE_PAST_HOLD_MS;
/** Refuse the hold window outside a test run. @internal */
export function setServePastHoldMsForTests(ms: number): void {
  if (!IS_TEST) throw new Error("setServePastHoldMsForTests is test-only");
  servePastHoldMs = ms;
}

interface ServePastEntry {
  target: NodeTarget;
  /** Resolves when the verified temp file EXISTS; rejects (and unhooks
   *  itself) when the fetch fails, so a failed attempt is not sticky. */
  promise: Promise<ServePastBytes>;
  /** The temp file's path once the fetch has settled — what the hold sweep
   *  removes. Null while the fetch runs or after it failed. */
  tmp: string | null;
  /** Live handles: every caller that received (or is awaiting) an artifact. */
  refs: number;
  /** Armed when refs reach zero; cleared by the next joiner. */
  holdTimer: ReturnType<typeof setTimeout> | null;
}

const servePast = new Map<NodeTarget, ServePastEntry>();

/**
 * Forget every lease: timers downed, slots emptied, settled temp copies
 * removed, hold restored. Tests only. Every in-process fetch the suites
 * await has settled before a reset runs — a response cannot complete before
 * the finally that resets — so no live reader is being pulled out from
 * under. A crashed-lease stray that outlives this is reaped by
 * {@link sweepStaleDownloads}.
 * @internal
 */
function purgeServePastForTests(): void {
  for (const entry of servePast.values()) {
    if (entry.holdTimer !== null) clearTimeout(entry.holdTimer);
    entry.holdTimer = null;
    entry.refs = 0;
    if (entry.tmp !== null) void rm(entry.tmp, { force: true }).catch(() => {});
  }
  servePast.clear();
  servePastHoldMs = SERVE_PAST_HOLD_MS;
}

/** Start (and register) a fresh serve-past fetch for one target. */
function startServePast(target: NodeTarget, signal?: AbortSignal): ServePastEntry {
  const entry = {
    target,
    refs: 0,
    tmp: null,
    holdTimer: null,
    promise: null as unknown as Promise<ServePastBytes>,
  } as ServePastEntry;
  entry.promise = fetchVerifiedTemp(target, signal)
    .then((bytes) => {
      entry.tmp = bytes.tmp;
      return bytes;
    })
    .catch((error: unknown) => {
      // The slot goes the moment the answer is "no bytes" — late callers must
      // not inherit a rejected promise (the same rule the cached arm's joiners
      // have always had).
      if (servePast.get(target) === entry) servePast.delete(target);
      throw error;
    });
  servePast.set(target, entry);
  return entry;
}

/**
 * Acquire verified release bytes WITHOUT overwriting the shelf path, shared
 * by every caller who needs them for one target.
 *
 * The shape replaced on 2026-10-31 was "each `cache: false` fetch owns its
 * own temp and fetches its own bytes", which made an "Update all" against an
 * operator-published shelf fire N simultaneous ~80 MB upstream fetches — the
 * batch timed out and burned its single-use download tokens while every
 * node updated one-at-a-time worked fine. The fetches of one target share
 * one verified temp now; each caller gets its own read of it and its own
 * release, and the file survives until the last handle is done plus a hold
 * window ({@link SERVE_PAST_HOLD_MS}) for downloads still in transit — see
 * {@link SERVE_PAST_HOLD_MS} for why the window exists at all.
 *
 * A settled copy is joinable only while its digest IS the release the
 * current index names (the index's 15-minute TTL can move under a hold); on
 * skew the slot is replaced by a fresh fetch while readers already handed
 * keep serving the copy they hold refs on. The download route's own
 * digest gate ({@link FetchedArtifact.digest}) remains the last word for a
 * tokened request.
 */
async function acquireServePast(target: NodeTarget, signal?: AbortSignal): Promise<FetchedArtifact> {
  // The ref is taken BEFORE the join is awaited: while a joiner is in flight,
  // the copy's refs read above zero, so a hold that reaches its expiry
  // mid-await cannot mistake the waiting joiner for nobody and delete the
  // settled file out from under it. Every failure path hands the ref back.
  let lease = adoptServePast(servePast.get(target) ?? startServePast(target, signal));
  let bytes: ServePastBytes;
  try {
    bytes = await joinServePast(lease);
  } catch {
    releaseServePastRef(lease);
    // One retry, same rule as the cached arm: onto a newer attempt if one
    // started meanwhile, else a fresh one. A second failure propagates
    // (having handed its ref back too).
    const retry = servePast.get(target);
    lease = adoptServePast(retry ?? startServePast(target, signal));
    try {
      bytes = await joinServePast(lease);
    } catch (error) {
      releaseServePastRef(lease);
      throw error;
    }
  }
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    releaseServePastRef(lease);
  };
  return {
    digest: bytes.digest,
    tag: bytes.tag,
    body: () => releasingFileStream(bytes.tmp, release),
    dispose: release,
  };
}

/** Join an entry as a live reader: disarm any pending hold, take the ref. */
function adoptServePast(entry: ServePastEntry): ServePastEntry {
  if (entry.holdTimer !== null) {
    clearTimeout(entry.holdTimer);
    entry.holdTimer = null;
  }
  entry.refs += 1;
  return entry;
}

/** Hand back one reader's ref; zero refs arms the hold window. */
function releaseServePastRef(entry: ServePastEntry): void {
  entry.refs -= 1;
  if (entry.refs <= 0) armServePastHold(entry);
}

/**
 * Await the entry's fetch, refusing a settled copy the release has moved
 * past, and a slot whose copy is no longer on disk at all.
 */
async function joinServePast(entry: ServePastEntry): Promise<ServePastBytes> {
  const bytes = await entry.promise;
  const expected = await fetchDigest(entry.target).catch(() => bytes.digest);
  if (expected !== bytes.digest) {
    if (servePast.get(entry.target) === entry) {
      // Retire the slot for future joiners; readers already handed still hold
      // this entry, and its last release will still sweep the file.
      servePast.delete(entry.target);
    }
    throw new Error(
      `${bytes.tag}'s ${bytes.assetName} serve-past copy (${bytes.digest.slice(0, 12)}…) is not the release this server now offers (${expected.slice(0, 12)}…)`,
    );
  }
  // The two awaits above outlive bookkeeping nobody else is obliged to
  // preserve: the hourly stray sweep unlinks `.download-` temps that age past
  // its bound (a leaked ref keeps the hold unarmed, so the sweep becomes the
  // only remover), and a slot can be retired while its file goes with it.
  // Handing out a dead path would answer a tokened download with a body that
  // dies at the first pull, so re-ask both facts and fail the join — loudly,
  // and with the slot retired — if either went stale.
  if (servePast.get(entry.target) !== entry) {
    throw new Error(`the ${bytes.tag} serve-past slot was retired while its copy was being read`);
  }
  if ((await stat(bytes.tmp).catch(() => null)) === null) {
    // The stat is itself an await: the slot may have been replaced (or
    // retired) since the line above. Only ever retire OUR OWN entry.
    if (servePast.get(entry.target) === entry) servePast.delete(entry.target);
    throw new Error(`the ${bytes.tag} serve-past copy's temp file vanished before it could be served`);
  }
  return bytes;
}

/** refs hit zero: keep the copy briefly for late downloads, then remove it. */
function armServePastHold(entry: ServePastEntry): void {
  if (entry.holdTimer !== null) return;
  const finish = (): void => {
    entry.holdTimer = null;
    if (entry.refs > 0) return; // a joiner arrived mid-timer
    if (servePast.get(entry.target) === entry) servePast.delete(entry.target);
    if (entry.tmp !== null) void rm(entry.tmp, { force: true }).catch(() => {});
  };
  if (servePast.get(entry.target) !== entry) {
    // Already replaced or unhooked: nothing can join this copy anymore.
    finish();
    return;
  }
  entry.holdTimer = setTimeout(finish, servePastHoldMs);
  // The hold must never be the reason a shutting-down process waits.
  entry.holdTimer.unref?.();
}

/** Bun's own reader type for a file stream — annotated anywhere else and the
 *  lib types disagree with what `stream().getReader()` actually returns. */
function fileReader(tmp: string) {
  return Bun.file(tmp).stream().getReader();
}

/**
 * A response body reading a temp copy of verified bytes, firing `onDone` once
 * the read ends however it ends: drained, cancelled, or broken mid-way. The
 * copy itself is the lease's to remove ({@link acquireServePast}); this is
 * only the handle's release, so one reader finishing can never pull the file
 * out from under another.
 */
function releasingFileStream(tmp: string, onDone: () => Promise<void>): ReadableStream<Uint8Array> {
  // The reader opens on the FIRST pull, not beside construction: a
  // materialization that throws before anything consumed the stream would
  // skip both the release and `controller.error`, leaving the lease holding a
  // reference nobody will ever drop and handing the caller a generic stream
  // error.
  let opened: ReturnType<typeof fileReader> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (opened === null) opened = fileReader(tmp);
        const { done, value } = await opened.read();
        if (done) {
          await onDone();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        await onDone();
        controller.error(error instanceof Error ? error : new Error(String(error)));
      }
    },
    async cancel(reason) {
      await opened?.cancel(reason).catch(() => {});
      await onDone();
    },
  });
}

/** Drop a partial download, best effort — it must never survive to be served. */
async function discard(sink: { end: () => unknown } | null, tmp: string): Promise<void> {
  if (sink !== null) {
    try {
      await sink.end();
    } catch {
      /* already closed */
    }
  }
  await rm(tmp, { force: true }).catch(() => {});
}

/**
 * The digest for a target this instance does not have, without downloading the
 * binary. `install.sh` asks for the sha AFTER the binary, so this is normally
 * served from the cache entry the binary's fetch just wrote; it exists for the order
 * being the other way round — and for `POST /api/nodes/:id/update`, which
 * embeds it in the command.
 *
 * It is the digest the SIGNED MANIFEST names (spec 2026-09-17), not the one a
 * `.sha256` sidecar carries: by the time this answers, the signature has been
 * checked, and a release the publisher did not sign throws.
 */
export async function fetchDigest(target: NodeTarget): Promise<string> {
  const { release, manifest } = await compatibleNodeReleaseOrThrow();
  const { binary } = releaseAssetNames("cli-node", target);
  const digest = manifest.manifest.assets[binary];
  if (digest === undefined) throw new Error(`${release.tag}'s signed manifest names no ${binary}`);
  return digest;
}

/** What {@link downloadVerified} needs, and nothing more. */
export interface DownloadVerifiedInput {
  /** Where the bytes come from. */
  url: string;
  /** The digest the same release published beside them, lowercase hex. */
  expectedDigest: string;
  /** Directory the temp file is written in — the binary's OWN directory, so the later rename is on one filesystem. */
  destDir: string;
  /** Base name of the temp file; a unique `.download-<pid>-<id>` suffix is appended. */
  destName: string;
  /** Progress, called per chunk. `total` is null when the server sent no length. */
  onProgress?: (received: number, total: number | null) => void;
  /**
   * Aborts the read. A caller that must not wait forever (the update route's
   * warm fetch) passes its own `AbortSignal.timeout(ms)`; the abort lands as
   * an ordinary fetch failure — partial temp deleted, nothing cached, the
   * error reaching the caller — the same shape every other failed download
   * already has.
   */
  signal?: AbortSignal;
}

/**
 * Download a release asset to a temp file, hashing as it goes.
 *
 * The same discipline {@link fetchArtifact} applies, for the caller that
 * writes a file and then EXECS it (the server's own update): a mismatch has
 * to leave nothing behind, because a file someone might run is a worse
 * leftover than a failed serve.
 *
 * It never chmods. Making a downloaded file executable is the caller's act and
 * belongs beside the caller's own version probe — this function's whole
 * promise is "these bytes are the ones that release published", and a file
 * this returns is not yet something anyone has decided to run.
 *
 * Each download gets its OWN temp file: two concurrent fetches of one target
 * whose bytes are NOT shared between them (a cached fetch and a serve-past
 * lease, or two serve-past copies for two different digests after the release
 * moved mid-batch) used to collide on a name keyed only by pid, interleave two
 * writers into one file, and let one caller's cleanup unlink another's
 * in-flight copy — the same shape the server's own update hit before its
 * job-slot claim made it single-flight (see `modules/updates/server-update.ts`).
 *
 * @returns the temp file's path, on a digest match
 * @throws when the download fails, exceeds {@link MAX_ARTIFACT_BYTES}, or does
 *   not match — in every case having deleted the partial file
 */
/**
 * Remove strays a crashed attempt left behind: no in-process path can clean
 * what a SIGKILL interrupted, and since the temp name is unique per attempt
 * (so concurrent fetches cannot collide), each crash leaves a NEW name rather
 * than one bounded slot to reuse. Every download therefore sweeps matching
 * strays older than {@link STALE_DOWNLOAD_MAX_AGE_MS} before it writes. Age
 * is the whole safety story: a live download of anything under the size cap
 * is minutes old, so it is never a stray. Best effort by design: a directory
 * we cannot read, or a file another writer just touched, costs a retry later,
 * never a failed download.
 */
async function sweepStaleDownloads(destDir: string, prefix: string, keep: string): Promise<void> {
  const staleBefore = Date.now() - STALE_DOWNLOAD_MAX_AGE_MS;
  let names: string[];
  try {
    names = await readdir(destDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || name === keep) continue;
    const path = join(destDir, name);
    const info = await stat(path).catch(() => null);
    if (info !== null && info.mtimeMs < staleBefore) {
      await rm(path, { force: true }).catch(() => {});
    }
  }
}

export async function downloadVerified(input: DownloadVerifiedInput): Promise<string> {
  const tmpName = `${input.destName}.download-${process.pid}-${randomUUID()}`;
  const tmp = join(input.destDir, tmpName);
  await sweepStaleDownloads(input.destDir, `${input.destName}.download-`, tmpName);
  // The server's own update passes a URL read from the release list — the
  // same untrusted field the lazy fetch pins (C12), hops included, so the
  // pin belongs here too: this download writes a file and the CALLER
  // EXECUTES it.
  const response = await fetchWithPinnedEgress(
    input.url,
    input.signal === undefined ? undefined : { signal: input.signal },
  );
  if (!response.ok || response.body === null) throw new Error(`${input.url} answered ${response.status}`);
  const lengthHeader = response.headers.get("content-length");
  const total = lengthHeader === null ? null : Number.parseInt(lengthHeader, 10);

  const sink = Bun.file(tmp).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let seen = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      seen += chunk.byteLength;
      if (seen > MAX_ARTIFACT_BYTES) {
        throw new Error(`${input.url} exceeded ${MAX_ARTIFACT_BYTES} bytes`);
      }
      hasher.update(chunk);
      sink.write(chunk);
      input.onProgress?.(seen, Number.isFinite(total) ? total : null);
    }
    await sink.end();
  } catch (error) {
    await discard(sink, tmp);
    throw error;
  }

  const actual = hasher.digest("hex");
  if (actual !== input.expectedDigest) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new Error(`${input.url} ${DIGEST_MISMATCH_PHRASE} (expected ${input.expectedDigest}, got ${actual})`);
  }
  return tmp;
}

/** Drop the memoized index. Tests, and anything that wants the next read fresh. @internal */
export function resetReleaseCacheForTests(): void {
  cachedIndex = null;
  indexFailure = null;
  indexInFlight = null;
  inFlight.clear();
  publishedAt.clear();
  purgeServePastForTests();
}
