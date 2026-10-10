import { runBounded } from "@internal/pane-runtime";
import {
  MIN_NODE_VERSION,
  NODE_PROTOCOL_VERSION,
  type NodeTarget,
  nodeArtifactFileName,
  nodeVersionSupported,
  semverLt,
} from "@internal/subshell-protocol";
import { autoFetchEnabled, compatibleNodeRelease, fetchedLedgerEntry } from "@/services/releases.js";
import { getLogger } from "@/utils/logger.js";
import { artifactPath, artifactSha, artifactStat, diskArtifactSha256Cached } from "./node-artifacts.js";

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
 * 1. the digest the instance ANNOUNCES for the shelf copy (its bytes, or an
 *    honest sidecar's: the very number `install.sh`'s checksum-skip compares)
 *    already EQUALS the release's signed digest AND the bytes agree with it
 *    → disk, no exec needed; a binary that disagrees with its own sidecar is
 *    a broken cell, not a fast path (see `shelfInconsistent`);
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
      /** Named on the fetch-failure log line, because "the release" needs a which. */
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
/** Shelf identities whose unmeasurability has already been warned once. */
const warnedUnmeasurable = new Set<string>();

/** The spec's "a warn line logs the unknown": once per file identity, not per request. */
function noteProbe(target: NodeTarget, key: string, facts: ShelfVersionFacts | null): void {
  if (facts !== null || warnedUnmeasurable.has(key)) return;
  warnedUnmeasurable.add(key);
  if (warnedUnmeasurable.size > PROBE_CACHE_MAX) {
    const oldest = warnedUnmeasurable.values().next().value;
    if (oldest !== undefined) warnedUnmeasurable.delete(oldest);
  }
  getLogger().warn(
    `node artifacts: the ${target} shelf copy answers no version line; the serve decision treats it as unmeasurable (the release wins when one is compatible, the copy serves when none is)`,
  );
}

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
  noteProbe(target, key, facts);
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
      // Same profile the async twin gets, as far as it has one: `runBounded`
      // hands the child the allowlisted env plus PATH; the version verb needs
      // nothing, but the two probes should not differ in what they run with.
      env: { PATH: process.env.PATH ?? "" },
    });
    if (proc.exitCode === 0) facts = parseVersionLine(proc.stdout.toString());
  } catch {
    facts = null;
  }
  noteProbe(target, key, facts);
  return rememberProbe(key, facts);
}

/** Drops the memoized shelf reads and their warn-once marks. Only for tests. @internal */
export function resetShelfProbeForTests(): void {
  probeCache.clear();
  warnedUnmeasurable.clear();
}

/**
 * The shelf answers for itself: it speaks THIS server's protocol and clears
 * its version floor — the same two facts the connect path enforces
 * (`nodeVersionSupported` is the floor's one rule, not a restatement).
 */
function shelfCanConnect(facts: ShelfVersionFacts | null): boolean {
  return facts === null || (facts.protocol === NODE_PROTOCOL_VERSION && nodeVersionSupported(facts.version));
}

/**
 * The single decision both download routes answer from. Never throws: every
 * release-side failure lands in `none` with its sentence, and every answer is
 * a complete verdict (bytes AND announced digest) so the route layer holds no
 * policy of its own.
 */
export async function resolveNodeServe(target: NodeTarget): Promise<NodeServeDecision> {
  const onDisk = artifactStat(target) !== null;
  // The two numbers the shelf can show: its true BYTES, and what the instance
  // ANNOUNCES for it (the sidecar-preferring artifactSha, which is exactly the
  // number a machine's checksum-skip compares against). Measuring the decision
  // on the ANNOUNCED value with the bytes agreeing is the invariant that
  // makes "skip" and "download" land on the same build everywhere, not just
  // on the fast path. Neither hash call may throw out of here: an unreadable
  // file is an unmeasurable shelf, not a 500.
  const diskDigest = onDisk ? await diskArtifactSha256Cached(target).catch(() => null) : null;
  const announced = onDisk ? await artifactSha(target).catch(() => diskDigest) : null;
  // A binary that does not match its own published `.sha256` is a broken
  // shelf cell, and every digest story goes quiet on it: the release wins,
  // or nothing does. Serving bytes under an announcement that denies them
  // would fail the installer's verify mid-flow with a worse message than
  // this one, and announcing the bytes would bless the corruption.
  const shelfInconsistent = diskDigest !== null && announced !== null && announced !== diskDigest;

  if (!autoFetchEnabled()) {
    // Air-gapped: the shelf is the only source, which is its whole purpose.
    if (!onDisk) {
      return {
        kind: "none",
        message: `No subshell build for "${target}" is published on this instance, and this server has no release source configured.`,
      };
    }
    if (shelfInconsistent) {
      return {
        kind: "none",
        message:
          `The ${target} binary on this server's shelf does not match its published .sha256, ` +
          "so nothing was served rather than bytes that would fail the installer's own check. Republish.",
      };
    }
    return { kind: "disk" };
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
    if (shelfInconsistent) {
      return {
        kind: "none",
        message:
          `The ${target} binary on this server's shelf does not match its published .sha256, and no ` +
          `compatible release can be fetched (${why}). Republish the shelf, or point the server at a release source.`,
      };
    }
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
    return { kind: "release", digest: releaseDigest, cache: true, releaseVersion };
  }

  if (shelfInconsistent) {
    // The release wins a broken cell outright: its bytes arrive under the
    // signed digest every consumer re-verifies. Our own bytes may be
    // replaced; an operator's broken pair is streamed past, untouched, for
    // them to republish.
    const ours = diskDigest !== null && (await fetchedLedgerEntry(target))?.digest === diskDigest;
    return { kind: "release", digest: releaseDigest, cache: ours, releaseVersion };
  }

  if (announced !== null && announced === releaseDigest) {
    // The shelf IS the release, in the only sense a consumer can tell: the
    // announced digest (which a skip compares) matches the release's signed
    // digest, and the bytes agree with the announcement by the check above.
    // The fast path: no exec, no fetch.
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
  // "Ours" is decided on TRUE BYTES against `.fetched.json`: a file edited
  // after our fetch is the operator's again, whatever the ledger's tag says.
  const ours = diskDigest !== null && (await fetchedLedgerEntry(target))?.digest === diskDigest;
  return {
    kind: "release",
    digest: releaseDigest,
    cache: ours, // our own bytes get replaced; the operator's are streamed past
    releaseVersion,
  };
}
