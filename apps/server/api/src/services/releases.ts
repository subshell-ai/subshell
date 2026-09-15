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
 *   enrolls against and never updates touches the network not at all. This is
 *   why the entry points are the download route's 404 branch and the update
 *   verb, rather than a routine of their own.
 * - **The bytes are streamed THROUGH, not staged and then served.** The
 *   alternative — download 80 MB, verify, then serve it — doubles the wait and
 *   holds an HTTP connection open with no bytes on it for as long as a minute,
 *   which is where reverse-proxy read timeouts live. Streaming hashes each
 *   chunk on its way past; a digest mismatch ERRORS the response mid-flight,
 *   so the node sees a truncated download and fails its own check. Nothing
 *   unverified is ever cached, and `install.sh` verifies the digest itself
 *   before the first `chmod +x` — that check is what makes streaming sound,
 *   and it predates this module. {@link downloadVerified} is the same
 *   hash-as-you-go discipline for the case with no client to stream to: the
 *   server's own update, which writes a file and then execs it.
 * - **A file we fetched is ours to replace; a file the operator put there is
 *   not.** Cached artifacts are recorded in a manifest with the release tag
 *   they came from, and only manifest-recorded files are ever superseded or
 *   deleted. A binary published by `release:node` has no manifest entry and is
 *   left alone forever.
 * - **A node release with no `release-manifest.json` is never offered.** The
 *   manifest is what says which protocol that agent speaks (spec §3.2), and
 *   handing a node a build this plane cannot talk to produces an agent that
 *   installs, reconnects and is closed 4406. Unknown is refused, by name, and
 *   the reason travels to the page.
 */
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MIN_AGENT_VERSION,
  NODE_PROTOCOL_VERSION,
  type NodeTarget,
  newestRelease,
  parseReleaseManifest,
  parseSidecarDigest,
  RELEASE_COMPONENTS,
  RELEASE_MANIFEST_NAME,
  type ReleaseCandidate,
  type ReleaseComponent,
  type ReleaseManifest,
  releaseAssetNames,
  semverLt,
} from "@internal/subshell-protocol";
import { IS_TEST, NODE_ARTIFACTS_DIR, SUBSHELL_RELEASE_URL } from "@/constants.js";
import { artifactPath } from "@/lib/node-artifacts.js";
import { getLogger } from "@/utils/logger.js";

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

/** What this instance fetched, and from which release. */
interface FetchedManifest {
  /** Keyed by target; absent means "not ours" — an operator-published file. */
  [target: string]: { tag: string; digest: string; fetchedAt: string } | undefined;
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
  inFlight.clear();
}

// ---------------------------------------------------------------------------
// Resolving the index
// ---------------------------------------------------------------------------

/** One release's tag, version, assets and (lazily read) manifest. */
export interface ResolvedRelease extends ReleaseCandidate {
  /** Download URL by asset name. */
  assets: Map<string, string>;
  /**
   * The parsed `release-manifest.json`, or null when the release carries none
   * (every cut before 2026-09-15) or it could not be read. Filled on first use
   * by {@link releaseManifest} and memoized with the index, so a page that only
   * asks "is there a newer server" never fetches it.
   */
  manifest: ReleaseManifest | null;
  /** Whether {@link manifest} has been looked for yet. */
  manifestRead: boolean;
}

/** Every component's newest published release, as of one read of the list. */
export interface ReleaseIndex {
  byComponent: Record<ReleaseComponent, ResolvedRelease | null>;
  /** When the list was read (epoch ms), so a view can say how stale it is. */
  checkedAt: number;
}

let cachedIndex: { at: number; index: ReleaseIndex } | null = null;

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

  let payload: unknown;
  try {
    const response = await fetch(api, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${api} answered ${response.status}`);
    payload = await response.json();
  } catch (error) {
    // Every failure names the URL it tried, the way the registry client does:
    // "could not reach the release source" with no address is unactionable.
    throw new Error(`could not read the releases from ${api}: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(payload)) throw new Error(`${api} did not answer a list of releases`);

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
        : { ...newest, assets: byTag.get(newest.tag) ?? new Map(), manifest: null, manifestRead: false };
  }

  const index: ReleaseIndex = { byComponent, checkedAt: now };
  cachedIndex = { at: now, index };
  return index;
}

/**
 * Drop the memoized index so the next read reaches the network — the Re-check
 * button, and the CLI's `update --check`.
 */
export async function refreshReleases(): Promise<ReleaseIndex> {
  cachedIndex = null;
  return resolveReleases();
}

/**
 * That release's `release-manifest.json`, fetched once and memoized on the
 * index entry.
 *
 * `null` for a release that publishes none (every cut before 2026-09-15), for
 * one whose manifest does not parse, and for one whose manifest could not be
 * fetched. All three have the same consequence for every caller — do not offer
 * this release to a node — so they are one answer rather than three.
 */
export async function releaseManifest(release: ResolvedRelease): Promise<ReleaseManifest | null> {
  if (release.manifestRead) return release.manifest;
  release.manifestRead = true;
  const url = release.assets.get(RELEASE_MANIFEST_NAME);
  if (url === undefined) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
    if (!response.ok) return null;
    release.manifest = parseReleaseManifest(await response.text());
  } catch {
    // An unreachable manifest is an unknown release, not a failed page.
    release.manifest = null;
  }
  return release.manifest;
}

/** The newest node release this server can talk to, or why there is none. */
export interface CompatibleNodeRelease {
  release: ResolvedRelease | null;
  /** Why `release` is null, in one sentence a page renders verbatim; `null` when it is not. */
  reason: string | null;
}

/**
 * The node release this plane may hand a machine.
 *
 * "Newest above the floor" was the old rule and it had a real hazard: a plane
 * one version behind would install an agent speaking a protocol it does not,
 * and that node enrolls, reconnects, and is closed 4406 forever. The manifest
 * (spec §3.2) is what makes the sharper question answerable without
 * downloading a binary — so the release offered is the newest `node` release
 * whose manifest's `nodeProtocol` EQUALS this server's, and whose version
 * clears `MIN_AGENT_VERSION`.
 *
 * Only the newest is considered, deliberately: walking back through older
 * releases looking for a protocol match would hand a machine a build nobody
 * cut for it, and the honest answer when the newest does not fit is "update the
 * server first".
 */
export async function compatibleNodeRelease(): Promise<CompatibleNodeRelease> {
  const index = await resolveReleases();
  const release = index.byComponent.node;
  if (release === null) return { release: null, reason: "the release source publishes no node-v* release" };
  if (semverLt(release.version, MIN_AGENT_VERSION)) {
    return {
      release: null,
      reason: `the newest node release (${release.tag}) is older than this server's minimum agent version ${MIN_AGENT_VERSION}`,
    };
  }
  const manifest = await releaseManifest(release);
  if (manifest === null) {
    return {
      release: null,
      reason: `node release ${release.version} carries no release manifest, so this server cannot tell whether it speaks protocol ${NODE_PROTOCOL_VERSION}`,
    };
  }
  if (manifest.nodeProtocol !== NODE_PROTOCOL_VERSION) {
    return {
      release: null,
      reason: `newest node release ${release.version} speaks protocol ${manifest.nodeProtocol}; this server speaks ${NODE_PROTOCOL_VERSION} — update the server first`,
    };
  }
  return { release, reason: null };
}

/** The node release to serve from, or a throw naming why there is none. */
async function nodeReleaseOrThrow(): Promise<ResolvedRelease> {
  const { release, reason } = await compatibleNodeRelease();
  if (release === null) throw new Error(reason ?? "no node release can be offered");
  return release;
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
 * with `release:node` has no entry and is never removed, whatever its age:
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

/** Record a freshly verified artifact as ours. */
async function record(target: NodeTarget, tag: string, digest: string): Promise<void> {
  const manifest = await readManifest();
  manifest[target] = { tag, digest, fetchedAt: new Date().toISOString() };
  await writeManifest(manifest);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** In-flight fetches, so two enrollments of one platform download once. */
const inFlight = new Map<NodeTarget, Promise<FetchedArtifact>>();

/** A verified-on-the-fly artifact: the bytes to serve, and what they are. */
export interface FetchedArtifact {
  /** The body to hand the client. Errors mid-flight if the digest does not match. */
  stream: ReadableStream<Uint8Array>;
  digest: string;
  tag: string;
}

/**
 * Fetch one platform's agent binary, streaming it to the caller as it arrives.
 *
 * The sidecar is fetched FIRST and in full — it is 65 bytes, and having the
 * expected digest before the first byte of the binary is what lets the stream
 * be checked as it passes rather than afterwards.
 */
export async function fetchArtifact(target: NodeTarget): Promise<FetchedArtifact> {
  const existing = inFlight.get(target);
  if (existing) return existing;
  const work = fetchArtifactUncoordinated(target).finally(() => inFlight.delete(target));
  inFlight.set(target, work);
  return work;
}

async function fetchArtifactUncoordinated(target: NodeTarget): Promise<FetchedArtifact> {
  const release = await nodeReleaseOrThrow();
  // Resolving told us which tag is current, so this is the moment anything
  // older becomes removable. Before the download, so a plane low on disk
  // reclaims before it spends.
  await supersede(release.tag);

  const names = releaseAssetNames("node", target);
  const binaryUrl = release.assets.get(names.binary);
  const sidecarUrl = release.assets.get(names.sidecar);
  if (!binaryUrl || !sidecarUrl) {
    throw new Error(`${release.tag} publishes no ${names.binary} — this platform is not in that release`);
  }

  const sidecar = await fetch(sidecarUrl, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  if (!sidecar.ok) throw new Error(`${sidecarUrl} answered ${sidecar.status}`);
  const expected = parseSidecarDigest(await sidecar.text());
  if (expected === null) throw new Error(`${sidecarUrl} is not a sha256 digest`);

  const upstream = await fetch(binaryUrl);
  if (!upstream.ok || upstream.body === null) {
    throw new Error(`${binaryUrl} answered ${upstream.status}`);
  }

  const tmp = `${artifactPath(target)}.fetch-${process.pid}`;
  const sink = Bun.file(tmp).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let seen = 0;

  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (!done) {
        seen += value.byteLength;
        if (seen > MAX_ARTIFACT_BYTES) {
          await discard(sink, tmp);
          controller.error(new Error(`${names.binary} exceeded ${MAX_ARTIFACT_BYTES} bytes`));
          return;
        }
        hasher.update(value);
        sink.write(value);
        controller.enqueue(value);
        return;
      }
      // The end of the body is the only place the answer exists. A mismatch
      // ERRORS the response rather than completing it, so the node sees a
      // truncated transfer and its own sha check fails — and nothing
      // unverified reaches the cache.
      const actual = hasher.digest("hex");
      if (actual !== expected) {
        await discard(sink, tmp);
        getLogger().warn(
          `node artifacts: ${names.binary} from ${release.tag} failed its digest check (expected ${expected}, got ${actual})`,
        );
        controller.error(new Error(`${names.binary} did not match the digest ${release.tag} published`));
        return;
      }
      await sink.end();
      await rename(tmp, artifactPath(target));
      await writeFile(`${artifactPath(target)}.sha256`, `${expected}\n`);
      await record(target, release.tag, expected);
      getLogger().info(`node artifacts: cached ${names.binary} from ${release.tag} (${seen} bytes)`);
      controller.close();
    },
    async cancel() {
      // The node hung up. Keep nothing: a partial file that later looked
      // complete would be served to the next machine.
      await reader.cancel().catch(() => {});
      await discard(sink, tmp);
    },
  });

  return { stream, digest: expected, tag: release.tag };
}

/** Drop a partial download, best effort — it must never survive to be served. */
async function discard(sink: { end: () => unknown }, tmp: string): Promise<void> {
  try {
    await sink.end();
  } catch {
    /* already closed */
  }
  await rm(tmp, { force: true }).catch(() => {});
}

/**
 * The digest for a target this instance does not have, without downloading the
 * binary. `install.sh` asks for the sha AFTER the binary, so this is normally
 * served from the file the streaming fetch just wrote; it exists for the order
 * being the other way round.
 */
export async function fetchDigest(target: NodeTarget): Promise<string> {
  const release = await nodeReleaseOrThrow();
  const { sidecar: name } = releaseAssetNames("node", target);
  return readDigest(release, name);
}

/** Fetch and parse one `.sha256` asset of a release. */
export async function readDigest(release: ResolvedRelease, assetName: string): Promise<string> {
  const url = release.assets.get(assetName);
  if (!url) throw new Error(`${release.tag} publishes no ${assetName}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const digest = parseSidecarDigest(await response.text());
  if (digest === null) throw new Error(`${url} is not a sha256 digest`);
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
  /** Base name of the temp file; `.download-<pid>` is appended. */
  destName: string;
  /** Progress, called per chunk. `total` is null when the server sent no length. */
  onProgress?: (received: number, total: number | null) => void;
}

/**
 * Download a release asset to a temp file, hashing as it goes.
 *
 * The same discipline {@link fetchArtifact} applies, for the case with no
 * client to stream to: the server's own update writes a file and then EXECS
 * it, so a mismatch has to leave nothing behind rather than error a response.
 *
 * It never chmods. Making a downloaded file executable is the caller's act and
 * belongs beside the caller's own version probe — this function's whole
 * promise is "these bytes are the ones that release published", and a file
 * this returns is not yet something anyone has decided to run.
 *
 * @returns the temp file's path, on a digest match
 * @throws when the download fails, exceeds {@link MAX_ARTIFACT_BYTES}, or does
 *   not match — in every case having deleted the partial file
 */
export async function downloadVerified(input: DownloadVerifiedInput): Promise<string> {
  const tmp = join(input.destDir, `${input.destName}.download-${process.pid}`);
  const response = await fetch(input.url);
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
    throw new Error(
      `${input.url} did not match the published digest (expected ${input.expectedDigest}, got ${actual})`,
    );
  }
  return tmp;
}

/** Drop the memoized index. Tests, and anything that wants the next read fresh. @internal */
export function resetReleaseCacheForTests(): void {
  cachedIndex = null;
  inFlight.clear();
  publishedAt.clear();
}
