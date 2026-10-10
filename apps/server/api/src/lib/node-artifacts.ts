import { createHash } from "node:crypto";
import { type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { NODE_TARGETS, type NodeTarget, nodeArtifactFileName } from "@internal/subshell-protocol";
import { NODE_ARTIFACTS_DIR } from "@/constants.js";

/**
 * The on-disk truth of which node agent binaries THIS instance can serve —
 * shared by the download routes (what to serve), `GET /api/settings/public`
 * (what the Nodes dialog may promise) and `subshell-server status` (what the
 * operator should see before anyone hits the wall). Lives here, not in the
 * route module, because the CLI's import graph must stay IO-free and these
 * helpers are pure fs reads.
 */

/** Absolute path of a target's binary. `target` is the route's isNodeTarget-gated value. */
export function artifactPath(target: NodeTarget): string {
  return join(NODE_ARTIFACTS_DIR, nodeArtifactFileName(target));
}

/**
 * The single published-artifact rule: a build is published only when a
 * regular, NON-EMPTY file sits at the target's path — a zero-length artifact
 * (partial write, deliberate stub) is unpublished, never served as a 200 and
 * never digested as the sha of "". The binary and sha routes share it so they
 * 404 identically for the same on-disk state.
 * @returns the file's stat, or null when unpublished (missing / not a file / empty)
 */
export function artifactStat(target: NodeTarget): Stats | null {
  try {
    const stat = statSync(artifactPath(target));
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch {
    return null; // ENOENT/ENOTDIR → unpublished → 404 upstream
  }
}

/**
 * The SHA-256 of the binary ACTUALLY on disk for `target`, or null when
 * unpublished — the same {@link artifactStat} rule, then hashed over the real
 * bytes rather than any sidecar, because a consumer comparing this against a
 * release's published digest is asking "would the file the download route
 * serves match it".
 *
 * The published builds are tens of MB, so the hash streams; nothing buffers
 * the file. A file that vanishes between the stat and the read answers null:
 * at download time the route lazy-fetches the verified release instead, so
 * "not on disk" is the honest answer rather than an error.
 */
export async function diskArtifactSha256(target: NodeTarget): Promise<string | null> {
  if (artifactStat(target) === null) return null;
  const hash = createHash("sha256");
  try {
    for await (const chunk of Bun.file(artifactPath(target)).stream()) {
      hash.update(chunk);
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  return hash.digest("hex");
}

const diskShaCache = new Map<string, string>();
const DISK_SHA_CACHE_MAX = 16;

/**
 * {@link diskArtifactSha256} for repeated asks: the serve resolver runs on
 * every download AND every `.sha256` probe, and hashing a ~100 MB shelf copy
 * per request would turn the probe into a CPU attack surface. One hash per
 * (path, mtime, size), noticed-changed exactly the way the download route's
 * sha cache notices, FIFO-capped because artifact paths churn.
 */
export async function diskArtifactSha256Cached(target: NodeTarget): Promise<string | null> {
  const stat = artifactStat(target);
  if (stat === null) return null;
  const key = `${artifactPath(target)}:${stat.mtimeMs}:${stat.size}`;
  if (diskShaCache.has(key)) return diskShaCache.get(key) ?? null;
  const sha = await diskArtifactSha256(target);
  if (diskShaCache.size >= DISK_SHA_CACHE_MAX) {
    const oldest = diskShaCache.keys().next().value;
    if (oldest !== undefined) diskShaCache.delete(oldest);
  }
  if (sha !== null) diskShaCache.set(key, sha);
  return sha;
}

/** Drops the memoized disk digests. Only for tests. @internal */
export function resetDiskShaCacheForTests(): void {
  diskShaCache.clear();
}

/** Max entries in {@link artifactSha}'s cache — FIFO-evicted so mtime churn can't grow it. */
const SHA_CACHE_MAX = 16;
/** Computed-sha cache, keyed `${binaryPath}:${binaryMtimeMs}[:${sidecarMtimeMs}]`. */
const shaCache = new Map<string, string>();

/**
 * The digest this instance ANNOUNCES for a target — and therefore the digest
 * the serve decision is measured against (spec 2026-10-09: the `.sha256`
 * answer and the binary answer must be the same fact, or a machine
 * checksum-skips past the very reconciliation the download applies).
 *
 * Null when unpublished — "published" being exactly {@link artifactStat}'s
 * rule, so the binary route and the sha route never disagree. An on-disk
 * `subshell-node-cli-<target>.sha256` sidecar wins when it holds a 64-hex
 * digest (publisher-provided truth: when the bytes have gone stale or
 * corrupt under it, announcing the PUBLISHED number makes `install.sh`'s own
 * verify refuse the file, which is fail-closed; announcing the corrupt
 * bytes' number would bless them). The bytes path shares
 * {@link diskArtifactSha256Cached}'s streaming hash and cache, so one
 * ~100 MB read per file identity serves the resolver, the announcement, and
 * the ledger comparison alike. A sidecar DISAGREEING with its own bytes is
 * not silently resolved here: {@link resolveNodeServe} treats the
 * disagreement as the shelf losing precedence, naming it.
 *
 * PUBLISH NOTE: the cache keys on MTIME, so an artifact replaced in place
 * with the SAME mtime keeps serving the cached sha. The publish path must
 * therefore swap atomically (write to a temp name + rename, or at least
 * touch the file) rather than overwrite bytes through the existing inode.
 */
export async function artifactSha(target: NodeTarget): Promise<string | null> {
  const path = artifactPath(target);
  const stat = artifactStat(target);
  if (!stat) return null;
  let sideMtime = 0;
  try {
    sideMtime = statSync(`${path}.sha256`).mtimeMs;
  } catch {
    // No sidecar: the announced digest IS the bytes' own, asked of the one
    // streaming cache rather than a second full-file buffer here.
    return diskArtifactSha256Cached(target);
  }

  const key = `${path}:${stat.mtimeMs}:${sideMtime}`;
  const cached = shaCache.get(key);
  if (cached !== undefined) return cached;

  const sidecarHex = (
    await Bun.file(`${path}.sha256`)
      .text()
      .catch(() => "")
  )
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase();
  // A present-but-not-hex sidecar (truncated write, HTML from a captive
  // portal) is no truth to prefer: the bytes speak.
  const sha = sidecarHex && /^[0-9a-f]{64}$/.test(sidecarHex) ? sidecarHex : await diskArtifactSha256Cached(target);
  // FIFO cap (Map iterates in insertion order): artifact rebuilds churn
  // mtimes, so an unbounded cache would be a slow leak.
  if (shaCache.size >= SHA_CACHE_MAX) {
    const oldest = shaCache.keys().next().value;
    if (oldest !== undefined) shaCache.delete(oldest);
  }
  if (sha !== null) shaCache.set(key, sha);
  return sha;
}

/** Drops the announced-digest cache. Only for tests. @internal */
export function resetAnnouncedShaCacheForTests(): void {
  shaCache.clear();
}

/**
 * The targets this instance ACTUALLY serves — the same rule as
 * {@link artifactStat}, widened to the whole closed set. A binary-only
 * server install (GitHub release) ships an EMPTY artifacts dir, which nothing
 * populates until `release:cli-node` publishes to it; until then the enroll
 * one-liner 404s on every machine, and this list is how the dialog and the
 * operator's own `status` know that instead of discovering it.
 */
export function publishedNodeTargets(): NodeTarget[] {
  return NODE_TARGETS.filter((target) => artifactStat(target) !== null);
}

/**
 * The one sentence both update surfaces say when the binary this instance
 * holds is not the release an update ordered and the plane cannot serve the
 * release instead. The update route refuses the ORDER with it; the download
 * route refuses the DOWNLOAD with it. Kept beside the artifact truth both
 * read, so the two refusals cannot drift apart.
 *
 * The remedy is publishing or a hand update, deliberately NOT "delete the
 * file": deleting helps only where the plane can then fetch the release, and
 * every path that says this sentence is one where it cannot.
 */
export function staleArtifactRefusal(target: NodeTarget): string {
  return `This server's published ${target} node binary is not the release the update ordered, so the node would install nothing. Publish that release's binaries to this server's node-artifacts directory with \`bun run release:cli-node\`, or update that machine by hand.`;
}
