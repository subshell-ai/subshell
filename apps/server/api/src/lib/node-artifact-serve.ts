import { runBounded } from "@internal/pane-runtime";
import {
  MIN_NODE_VERSION,
  NODE_PROTOCOL_VERSION,
  type NodeTarget,
  nodeArtifactFileName,
  semverLt,
} from "@internal/subshell-protocol";
import { autoFetchEnabled, compatibleNodeRelease, fetchedLedgerEntry } from "@/services/releases.js";
import { artifactPath, artifactStat, diskArtifactSha256Cached } from "./node-artifacts.js";

/**
 * What this instance would ACTUALLY serve for one target, decided in one
 * place so the binary route and the `.sha256` route can never disagree (spec
 * 2026-10-09).
 *
 * They used to: both answered "the shelf file, always", and the shelf was
 * never asked what it is. A plane whose server moved across a protocol bump
 * kept handing out the old agent with a true digest of a lie: the machine
 * enrolls (REST, no protocol involved), starts, and redials in a
 * `4410 handshake refused` loop forever, while the route it came through
 * reports success. `compatibleNodeRelease()` already refuses to OFFER a
 * release the server cannot talk to; this module applies the same question to
 * the disk, because a shelf copy is an offer too.
 *
 * The rule, when a release source is configured: the shelf may serve its own
 * bytes, the release, or nothing — whichever of these is true FIRST:
 *
 * 1. the shelf's bytes ARE the compatible release (digest match, no exec
 *    needed) → disk;
 * 2. the shelf reports (by running it: `<file> version`, the same discipline
 *    the server's self-update applies to a downloaded binary) a NEWER semver
 *    and the server's protocol → disk. This is the hand-publish/dev-loop
 *    cell: `release:cli-node` from a checkout stays operator truth;
 * 3. otherwise, if a compatible release exists → the release wins: it is the
 *    newest build this server can talk to, which is the whole promise the
 *    one-liner makes. Bytes this instance fetched (`.fetched.json` says so,
 *    digest to the digest) are REPLACED by the cache; bytes it did not are
 *    streamed past, never overwritten, same rule the update route learned on
 *    2026-09-21;
 * 4. no compatible release at all → the shelf serves only while it can
 *    actually connect (its reported protocol matches, its version clears the
 *    floor); an unmeasurable shelf serves (unknown is not a verdict); a
 *    shelf that reports the wrong protocol gets the refusal the machine would
 *    otherwise discover at `4410`, in the response instead.
 *
 * Air-gapped (`SUBSHELL_RELEASE_URL` empty) the shelf is the only source and
 * always wins, unchanged; `subshell-server status` carries what the shelf
 * claims so a dead shelf is visible before a fleet finds it.
 */
export type NodeServeDecision =
  /** Serve the shelf file as it sits; the sha route announces its digest. */
  | { kind: "disk" }
  | {
      kind: "release";
      /** The signed manifest's digest — what the sha route announces. */
      digest: string;
      /** Cache the fetched bytes over the shelf: true only when there is no shelf file, or this instance fetched the one there. */
      cache: boolean;
      /** The fetch failed and the shelf file, if any, may still be served (it can connect, or cannot be measured). False when the shelf reports a protocol this server refuses. */
      diskFallback: boolean;
      /** Why the release was the answer, for the log line the failure path leaves. */
      releaseVersion: string;
    }
  | {
      kind: "none";
      /** One sentence for the 404 body AND the warn log; `install.sh`'s 404 arm already renders the outcome, the reason is for the operator. */
      message: string;
    };

export interface ShelfVersionFacts {
  /** The semver the binary's own version line printed. */
  version: string;
  /** The protocol it claims to speak. */
  protocol: number;
}

/** The agent's own line: `subshell 1.4.2 (node protocol v14)` (node CLI's `version` verb). */
const VERSION_LINE = /^subshell ([0-9][0-9A-Za-z.+-]*) \(node protocol v(\d+)\)/;

const probeCache = new Map<string, ShelfVersionFacts | null>();
const PROBE_CACHE_MAX = 32;

function probeCacheKey(target: NodeTarget): string | null {
  const stat = artifactStat(target);
  if (stat === null) return null;
  return `${artifactPath(target)}:${stat.mtimeMs}:${stat.size}`;
}

function rememberProbe(key: string, facts: ShelfVersionFacts | null): ShelfVersionFacts | null {
  if (probeCache.size >= PROBE_CACHE_MAX) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) probeCache.delete(oldest);
  }
  probeCache.set(key, facts);
  return facts;
}

function parseVersionLine(stdout: string): ShelfVersionFacts | null {
  const m = VERSION_LINE.exec(stdout.trim());
  return m === null ? null : { version: m[1], protocol: Number(m[2]) };
}

/**
 * What the shelf copy SAYS it is, by running it once under the shared spawn
 * bounds. `null` means unmeasurable: vanished, not executable, wrong side,
 * timeout, or a version line that is not the agent's own. A throw never
 * escapes here — an unmeasurable shelf is a fact, not a failure.
 */
export async function shelfVersionFacts(target: NodeTarget): Promise<ShelfVersionFacts | null> {
  const key = probeCacheKey(target);
  if (key === null) return null;
  if (probeCache.has(key)) return probeCache.get(key) ?? null;
  let facts: ShelfVersionFacts | null = null;
  try {
    const run = await runBounded([artifactPath(target), "version"], { timeoutMs: 5000 });
    if (run.code === 0) facts = parseVersionLine(run.stdout);
  } catch {
    facts = null; // spawn refuses even under runBounded's contract on some platforms
  }
  return rememberProbe(key, facts);
}

/**
 * The same read, synchronously, for `subshell-server status` — whose whole
 * view is built by one synchronous function (see the status-db-safety tests)
 * and cannot await. `Bun.spawnSync` has no deadline: the only file this can
 * hang on is one the OPERATOR placed on the shelf, on the operator's own
 * machine, which is the accepted posture of the resolution ladders
 * (`docs/security.md`: they run what they find). The download routes use the
 * bounded async probe; both share this cache.
 */
export function shelfVersionFactsSync(target: NodeTarget): ShelfVersionFacts | null {
  const key = probeCacheKey(target);
  if (key === null) return null;
  if (probeCache.has(key)) return probeCache.get(key) ?? null;
  let facts: ShelfVersionFacts | null = null;
  try {
    const proc = Bun.spawnSync({
      cmd: [artifactPath(target), "version"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: {},
    });
    if (proc.exitCode === 0) facts = parseVersionLine(proc.stdout.toString());
  } catch {
    facts = null;
  }
  return rememberProbe(key, facts);
}

/** Drops the memoized shelf reads. Only for tests. @internal */
export function resetShelfProbeForTests(): void {
  probeCache.clear();
}

/** The shelf answers for itself: it speaks THIS server's protocol and clears its version floor. */
function shelfCanConnect(facts: ShelfVersionFacts | null): boolean {
  return facts === null || (facts.protocol === NODE_PROTOCOL_VERSION && !semverLt(facts.version, MIN_NODE_VERSION));
}

/**
 * The single decision both download routes answer from. Never throws: every
 * release-side failure lands in `none` with its sentence, and every serve
 * path carries its own fallback flag so the route layer holds no policy.
 */
export async function resolveNodeServe(target: NodeTarget): Promise<NodeServeDecision> {
  const onDisk = artifactStat(target) !== null;

  if (!autoFetchEnabled()) {
    // Air-gapped: the shelf is the only source, which is its whole purpose.
    return onDisk
      ? { kind: "disk" }
      : {
          kind: "none",
          message: `No subshell build for "${target}" is published on this instance, and this server has no release source configured.`,
        };
  }

  // An unreachable release source is an unknown release, not a failed page:
  // the same reading `checkReleaseManifest` gives the tiny reads. What the
  // shelf can honestly serve on its own still stands.
  let compatible: Awaited<ReturnType<typeof compatibleNodeRelease>>;
  try {
    compatible = await compatibleNodeRelease();
  } catch (error) {
    compatible = {
      release: null,
      manifest: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const releaseDigest =
    compatible.manifest === null ? undefined : compatible.manifest.manifest.assets[nodeArtifactFileName(target)];
  const releaseVersion = compatible.release?.version ?? null;

  if (compatible.release === null || releaseDigest === undefined || releaseVersion === null) {
    const why = compatible.reason ?? `the newest node release names no ${nodeArtifactFileName(target)} in its manifest`;
    if (!onDisk) return { kind: "none", message: why };
    const facts = await shelfVersionFacts(target);
    if (shelfCanConnect(facts)) return { kind: "disk" };
    return {
      kind: "none",
      message:
        `The ${target} build this instance holds reports ${facts?.version} (protocol v${facts?.protocol}); ` +
        `this server speaks protocol v${NODE_PROTOCOL_VERSION} and needs node ${MIN_NODE_VERSION}+, and it cannot ` +
        `fetch a release it can talk to (${why}). Publish a node build for this protocol, or set SUBSHELL_RELEASE_URL.`,
    };
  }

  if (!onDisk) {
    return { kind: "release", digest: releaseDigest, cache: true, diskFallback: false, releaseVersion };
  }

  const diskDigest = await diskArtifactSha256Cached(target);
  if (diskDigest !== null && diskDigest === releaseDigest) {
    // The shelf IS the release: the fast path, no exec, no fetch.
    return { kind: "disk" };
  }

  const facts = await shelfVersionFacts(target);
  const releaseWinsBecauseShelfCannotConnect = facts !== null && facts.protocol !== NODE_PROTOCOL_VERSION;
  if (
    !releaseWinsBecauseShelfCannotConnect &&
    facts !== null &&
    shelfCanConnect(facts) &&
    semverLt(releaseVersion, facts.version)
  ) {
    // The operator's shelf is AHEAD of the release and connects: hand-publish
    // stays truth, exactly as before.
    return { kind: "disk" };
  }

  // Release wins: it is the newest build this server can talk to and the shelf
  // does not beat it (older, equal-but-different bytes, or refused protocol).
  const ours = diskDigest !== null && (await fetchedLedgerEntry(target))?.digest === diskDigest;
  return {
    kind: "release",
    digest: releaseDigest,
    cache: ours, // our own bytes get replaced; the operator's are streamed past
    diskFallback: shelfCanConnect(facts),
    releaseVersion,
  };
}
