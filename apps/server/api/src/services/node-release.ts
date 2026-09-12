/**
 * Fetching node agent binaries from the repository's own releases, lazily.
 *
 * A control plane installed from a release tarball has an empty
 * `node-artifacts` directory, so every enroll one-liner 404s on every platform
 * until someone runs `release:node` from a checkout or copies assets in by
 * hand. That was the only answer while the repository was private; it is
 * public now, and the release an operator was being told to copy from is one
 * the server can read itself.
 *
 * Three rules shape this module, and each is a decision rather than a detail:
 *
 * - **Nothing is fetched until a machine asks for it.** There is no warm-up,
 *   no boot-time sweep, no admin "download now" button, and no background
 *   poll. A plane whose nodes are all linux-x64 never spends a byte on the two
 *   darwin builds, and a plane nobody enrolls against never touches the
 *   network at all. This is why the entry point is the download route's 404
 *   branch rather than a route of its own.
 * - **The bytes are streamed THROUGH, not staged and then served.** The
 *   alternative — download 80 MB, verify, then serve it — doubles the wait and
 *   holds an HTTP connection open with no bytes on it for as long as a minute,
 *   which is where reverse-proxy read timeouts live. Streaming hashes each
 *   chunk on its way past; a digest mismatch ERRORS the response mid-flight,
 *   so the node sees a truncated download and fails its own check. Nothing
 *   unverified is ever cached, and `install.sh` verifies the digest itself
 *   before the first `chmod +x` — that check is what makes streaming sound,
 *   and it predates this module.
 * - **A file we fetched is ours to replace; a file the operator put there is
 *   not.** Cached artifacts are recorded in a manifest with the release tag
 *   they came from, and only manifest-recorded files are ever superseded or
 *   deleted. A binary published by `release:node` has no manifest entry and is
 *   left alone forever.
 */
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MIN_AGENT_VERSION,
  type NodeReleaseCandidate,
  type NodeTarget,
  newestNodeRelease,
  nodeReleaseAssetNames,
  parseSidecarDigest,
  semverLt,
} from "@internal/subshell-protocol";
import { IS_TEST, NODE_ARTIFACTS_DIR, SUBSHELL_NODE_RELEASE_URL } from "@/constants.js";
import { artifactPath } from "@/lib/node-artifacts.js";
import { getLogger } from "@/utils/logger.js";

/** How long a resolved release is trusted before the list is read again. */
const RELEASE_TTL_MS = 15 * 60 * 1000;
/** Budget for the release list and the (tiny) sidecar. The binary has no deadline; it streams. */
const METADATA_TIMEOUT_MS = 15_000;
/**
 * Refuse a binary larger than this. The published builds are 70-90 MB, so the
 * cap is loose on purpose: it exists to stop a misconfigured URL streaming
 * something unbounded onto the data volume, not to police the real artifacts.
 */
const MAX_ARTIFACT_BYTES = 300 * 1024 * 1024;

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
 * serve only what is on disk, which is exactly the behaviour that predates
 * this module.
 */
function releaseApiUrl(): string | null {
  const url = testOverride ?? SUBSHELL_NODE_RELEASE_URL;
  return url === "" ? null : url;
}

/** Whether this instance will fetch a missing binary rather than 404. */
export function autoFetchEnabled(): boolean {
  return releaseApiUrl() !== null;
}

/**
 * Point this instance at a different releases endpoint. Tests only — a
 * production process must never be redirected, so the setter refuses outside
 * a test run (the same seam `setPluginsRegistryUrlForTests` uses).
 * @internal
 */
let testOverride: string | null = null;
export function setNodeReleaseUrlForTests(url: string | null): void {
  if (!IS_TEST) throw new Error("setNodeReleaseUrlForTests is test-only");
  testOverride = url;
  cachedRelease = null;
  inFlight.clear();
}

// ---------------------------------------------------------------------------
// Resolving which release to serve from
// ---------------------------------------------------------------------------

/** One release's tag and the download URL of each asset, by asset name. */
export interface ResolvedRelease extends NodeReleaseCandidate {
  assets: Map<string, string>;
}

let cachedRelease: { at: number; release: ResolvedRelease } | null = null;

/** The shape of the releases list this reads. Everything else in the payload is ignored. */
interface ReleasePayload {
  tag_name?: unknown;
  draft?: unknown;
  assets?: unknown;
}

/**
 * The newest `node-v*` release, memoized for {@link RELEASE_TTL_MS}.
 *
 * Drafts are skipped: the release pipeline publishes draft-then-live, so a
 * cut in flight is visible to a token that can see drafts and must not be
 * handed to a node. A release BELOW `MIN_AGENT_VERSION` is refused outright —
 * this plane would reject the agent it just installed, and failing here names
 * the reason instead of leaving a node that enrolls and is then turned away.
 */
export async function resolveRelease(): Promise<ResolvedRelease> {
  const api = releaseApiUrl();
  if (api === null) throw new Error("this server does not fetch node binaries (SUBSHELL_NODE_RELEASE_URL is empty)");
  const now = Date.now();
  if (cachedRelease && now - cachedRelease.at < RELEASE_TTL_MS) return cachedRelease.release;

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
    throw new Error(`could not read the node releases from ${api}: ${error instanceof Error ? error.message : error}`);
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
  }

  const newest = newestNodeRelease([...byTag.keys()]);
  if (newest === null) throw new Error(`no node-v* release is published at ${api}`);
  if (semverLt(newest.version, MIN_AGENT_VERSION)) {
    throw new Error(
      `the newest node release (${newest.tag}) is older than this server's minimum agent version ${MIN_AGENT_VERSION}`,
    );
  }
  const release: ResolvedRelease = { ...newest, assets: byTag.get(newest.tag) ?? new Map() };
  cachedRelease = { at: now, release };
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
 * Fetch one platform's binary, streaming it to the caller as it arrives.
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
  const release = await resolveRelease();
  // Resolving told us which tag is current, so this is the moment anything
  // older becomes removable. Before the download, so a plane low on disk
  // reclaims before it spends.
  await supersede(release.tag);

  const names = nodeReleaseAssetNames(target);
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
  const release = await resolveRelease();
  const { sidecar: name } = nodeReleaseAssetNames(target);
  const url = release.assets.get(name);
  if (!url) throw new Error(`${release.tag} publishes no ${name}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const digest = parseSidecarDigest(await response.text());
  if (digest === null) throw new Error(`${url} is not a sha256 digest`);
  return digest;
}

/** Drop the memoized release. Tests, and anything that wants the next read fresh. @internal */
export function resetReleaseCacheForTests(): void {
  cachedRelease = null;
  inFlight.clear();
}
