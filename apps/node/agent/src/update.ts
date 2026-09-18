import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_RELEASE_API,
  hostReleaseTarget,
  NODE_RESULT_DIGEST_MISMATCH,
  NODE_RESULT_DOWNLOAD_FAILED,
  NODE_RESULT_MANIFEST_UNVERIFIED,
  NODE_RESULT_NOT_COMPILED,
  NODE_RESULT_VERSION_MISMATCH,
  newestRelease,
  parseReleaseTag,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  RELEASE_PUBKEY,
  releaseAssetNames,
} from "@internal/subshell-protocol";
import { verifyReleaseManifest } from "@internal/subshell-protocol/release-signature";
import { log } from "./log.js";
import { looksLikeEntryScript, selfInvokePrefix } from "./self-invoke.js";
import { serviceExecArgv } from "./service.js";
import { AGENT_VERSION } from "./version.js";

/**
 * Replacing this agent's own binary (spec 2026-09-15 §5.2).
 *
 * The node half of the shared shape: **every install of a binary is a
 * transaction the NEW binary completes at boot.** The updater process cannot
 * see the future boot; the booting process can see the past update. So
 * whoever swaps writes a marker and keeps the old file as `<binary>.previous`,
 * and the agent that comes up either finds its connection accepted (delete
 * both — `daemon.ts`) or finds itself refused with 4406 (swap `.previous`
 * back, record the failure, exit for the manager to respawn the old one).
 *
 * The node has no database, so that swap-back IS its whole rollback. There is
 * nothing else to restore and nothing that could have been written in between.
 *
 * Both entry points — the `update` command from the plane and `subshell
 * update` at the keyboard — run {@link applyUpdate}, which is what keeps the
 * download, the verification and the marker one implementation rather than
 * two that drift.
 *
 * ## macOS quarantine
 *
 * Deliberately unhandled, because nothing on either path sets the attribute:
 * `fetch` and `copyFile` do not, the desktop app strips it from its sidecar
 * before offering the file (`crates/desktop-core` `sidecar.rs`), and the CLI's
 * `--from` copies a path the operator named. A `com.apple.quarantine` xattr
 * would come from a browser download, which is not a path this module has.
 */

/** Cap on a downloaded artifact, mirroring the server's own `MAX_ARTIFACT_BYTES`. */
export const MAX_UPDATE_BYTES = 300 * 1024 * 1024;

/** How long the release-list and sidecar reads wait before giving up. */
const METADATA_TIMEOUT_MS = 10_000;

/** File name of the in-progress marker inside the agent's data dir. */
export const UPDATE_PENDING_FILE = "update-pending.json";
/** File name of the marker a reverted update leaves behind. */
export const UPDATE_FAILED_FILE = "update-failed.json";

/** The signed manifest traveling with a remote update (spec 2026-09-17 §4). */
export interface UpdateManifestSource {
  /** The EXACT published `release-manifest.json` bytes — never a re-serialization. */
  bytes: Uint8Array | string;
  /** The published `release-manifest.json.sig` armor, verbatim. */
  sig: string;
}

/** Where the new bytes come from — a release URL with its digest, or a local file. */
export type UpdateSource =
  | {
      kind: "url";
      /** Absolute http(s) URL; the plane bakes a single-use download token into it. */
      url: string;
      /** Lowercase-hex sha256 the bytes must hash to. */
      sha256: string;
      /**
       * The release's signed manifest (spec 2026-09-17 §5 path 1). REQUIRED
       * for a URL install: the digest that gates the swap is the one THIS
       * document names for THIS platform's filename, once its signature
       * verifies against the compiled-in `RELEASE_PUBKEY`. `null` means no
       * publisher signed anything — {@link applyUpdate} refuses it. The
       * `--from` path is the one signature-free route (§4: a local operator
       * names the file), and it is a different variant of this union.
       */
      manifest: UpdateManifestSource | null;
    }
  | {
      kind: "file";
      /** A path the operator (or the desktop app) named; there is no digest to check. */
      path: string;
    };

/** Everything {@link applyUpdate} needs. */
export interface ApplyUpdateInput {
  /** Where the new binary comes from. */
  source: UpdateSource;
  /** The version the new binary must report from `<binary> version`. */
  version: string;
  /** Act even though the service definition would take live panes down. */
  force?: boolean;
  /** Whether to drive the restart here (the CLI) or leave it to the caller (the plane executor). */
  restart: boolean;
  /** Who asked, recorded in the marker so a post-mortem knows. */
  origin: "cli" | "plane" | "desktop";
  /** Data dir the markers live in (default: read from the enrolled config by the caller). */
  dataDir: string;
  /** Service-manager restart seam (injected; the CLI passes `controlService`'s wrapper). */
  restartService?: (force: boolean) => Promise<{ code: number; out: string; err: string }>;
  /** Spawn seam for the `<temp> version` probe (injected by tests). */
  probeVersion?: (binary: string) => Promise<string | null>;
}

/** What the marker file holds, on either side of the swap. */
export interface UpdateMarker {
  /** Version that was running when the swap started. */
  from: string;
  /** Version being installed. */
  to: string;
  /** Absolute path of the binary that was replaced. */
  binary: string;
  /** Absolute path of the copy kept beside it. */
  previousBinary: string;
  /** ISO 8601 of when the swap began. */
  startedAt: string;
  /** Who asked. */
  origin: "cli" | "plane" | "desktop";
}

/** A failed marker is the pending one plus why it was reverted. */
export interface UpdateFailure extends UpdateMarker {
  /** Why the update was rolled back, in the words the plane or the agent used. */
  reason: string;
  /** ISO 8601 of the revert. */
  failedAt: string;
}

/**
 * An {@link applyUpdate} refusal that carries a wire constant.
 *
 * The plane matches `NodeRpcError.detail` by EQUALITY against the protocol's
 * `NODE_RESULT_*` strings, so the executor has to answer one of them verbatim
 * rather than a sentence. A human at the keyboard wants the sentence, so both
 * travel: `detail` is the constant, `message` is what the CLI prints.
 */
export class UpdateRefused extends Error {
  /** The exact `NODE_RESULT_*` constant this refusal maps to. */
  readonly detail: string;

  constructor(detail: string, message: string) {
    super(message);
    this.name = "UpdateRefused";
    this.detail = detail;
  }
}

/** Absolute path of the pending marker for a data dir. */
export function pendingMarkerPath(dataDir: string): string {
  return join(dataDir, UPDATE_PENDING_FILE);
}

/** Absolute path of the failed marker for a data dir. */
export function failedMarkerPath(dataDir: string): string {
  return join(dataDir, UPDATE_FAILED_FILE);
}

/** Read a marker file, or null when it is absent or unparseable. */
export async function readMarker<T extends UpdateMarker>(path: string): Promise<T | null> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());
    if (typeof parsed !== "object" || parsed === null) return null;
    const m = parsed as Partial<UpdateMarker>;
    if (typeof m.binary !== "string" || typeof m.previousBinary !== "string") return null;
    if (typeof m.from !== "string" || typeof m.to !== "string") return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/** Write a marker 0600 into a 0700 data dir, temp+rename so a reader never sees half of one. */
async function writeMarker(path: string, body: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** Which rung named the binary. Reported so a person can tell "the unit says so" from "this is me". */
export type AgentBinarySource = "service definition" | "this process";

/** Injectable seams for {@link resolveAgentBinary}, so the ladder is testable without a real unit or plist. */
export interface AgentBinaryDeps {
  /** Runtime platform (default: `process.platform`). */
  platform?: NodeJS.Platform;
  /** User home the unit/plist paths hang off (default: `homedir()`). */
  home?: string;
  /** Read a file's text, or null when absent/unreadable (default: a real read). */
  readFile?: (path: string) => Promise<string | null>;
  /** Run a command — only ever `plutil` (default: a real spawn). */
  runCmd?: (cmd: string[]) => Promise<{ code: number; out: string; err: string }>;
}

/**
 * Where this agent's binary is, refusing the shapes that cannot be swapped.
 *
 * **The service definition is asked FIRST, and this is the whole point.** The
 * manager executes the file the unit or plist NAMES, so that file is the only
 * answer to the question an update is actually asking. Resolving from
 * `process.execPath` instead — which is what this did until 2026-09-15 — is
 * correct only while the running process happens to be the installed one, and
 * `subshell update` typed in a terminal runs whichever copy is first on PATH.
 * On a host where those differ, the update downloaded, verified and swapped a
 * binary nobody runs, reported success, and the manager brought the OLD
 * version back up on the next restart. That failure is invisible from the
 * outside: `version` still answers, just from the copy that was never
 * replaced. The server's `resolveInstalledBinary` has always read its
 * definition first for exactly this reason; the node now does too.
 *
 * Two refusals, both about there being no single file to replace:
 *
 * - **Two tokens** — an interpreter plus a script, which is the dev-form
 *   install `execLine()` writes. Replacing token one would overwrite `bun`
 *   itself, so this refuses and names the checkout as the remedy. The same
 *   trap `selfInvokePrefix` answering with ARGUMENTS catches on the fallback
 *   rung.
 * - **A named file that is not there** — a broken install to report, never a
 *   licence to replace a different binary instead. Falling back here would
 *   resurrect the entire bug above.
 *
 * A directory this user cannot write is the last refusal, named rather than
 * discovered halfway through: a failed `rename` after a 70 MB download is a
 * worse way to learn it.
 */
export async function resolveAgentBinary(
  deps: AgentBinaryDeps = {},
): Promise<{ binary: string; dir: string; source: AgentBinarySource }> {
  const { binary, source } = await resolveAgentBinaryPath(deps);
  const dir = dirname(binary);
  try {
    const info = await stat(binary);
    if (!info.isFile()) throw new Error("not a regular file");
  } catch (err) {
    throw new UpdateRefused(
      NODE_RESULT_NOT_COMPILED,
      source === "service definition"
        ? `the installed service names ${binary}, which cannot be read: ${err instanceof Error ? err.message : String(err)}`
        : `cannot read this agent's own binary at ${binary}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const probe = join(dir, `.subshell-write-probe-${process.pid}`);
    await writeFile(probe, "");
    await rm(probe, { force: true });
  } catch {
    throw new UpdateRefused(
      NODE_RESULT_DOWNLOAD_FAILED,
      `${dir} is not writable by this user, so the agent binary there cannot be replaced`,
    );
  }
  return { binary, dir, source };
}

/**
 * The same ladder WITHOUT touching the filesystem beyond reading the
 * definition — no stat, and above all no write probe.
 *
 * Split out for `status`, which must name the file an update would replace and
 * must stay READ-ONLY doing it. Folding the probe into a status read would
 * create and delete a file in `~/.local/bin` every time anyone asked, and
 * would report `binary: null` for an un-writable directory — which is a true
 * thing about updating and a false thing about where this agent lives.
 */
export async function resolveAgentBinaryPath(
  deps: AgentBinaryDeps = {},
): Promise<{ binary: string; source: AgentBinarySource }> {
  const argv = await serviceExecArgv({
    platform: deps.platform ?? process.platform,
    home: deps.home ?? homedir(),
    readFile: deps.readFile ?? (async (path) => await readFile(path, "utf8").catch(() => null)),
    runCmd:
      deps.runCmd ??
      (async (cmd) => {
        try {
          const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
          const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
          return { code: (await proc.exited) ?? 1, out, err };
        } catch {
          return { code: 127, out: "", err: "could not run the command" };
        }
      }),
  });

  let binary: string;
  let source: AgentBinarySource;
  if (argv !== null) {
    // `execLine()` writes `[...selfInvokePrefix(), <verb>]`, so this agent's
    // definition ALWAYS carries a trailing `run` — a compiled install reads
    // `[<binary>, "run"]` and a dev-form one `[bun, <entry>.ts, "run"]`. The
    // shape that cannot be swapped is therefore the one whose SECOND token is
    // an entry script, NOT merely one with more than one token. (The server's
    // reader counts tokens because its unit carries no verb; copying that rule
    // here would refuse every correctly installed node.) Replacing token one
    // of a dev-form line would overwrite `bun` itself.
    if (argv.length > 1 && looksLikeEntryScript(argv[1] as string)) {
      throw new UpdateRefused(
        NODE_RESULT_NOT_COMPILED,
        "the installed service runs this agent from a source checkout, not a compiled binary; update the checkout instead",
      );
    }
    binary = argv[0] as string;
    source = "service definition";
  } else {
    const prefix = selfInvokePrefix();
    if (prefix.args.length > 0) {
      throw new UpdateRefused(
        NODE_RESULT_NOT_COMPILED,
        "this agent is running from a source checkout, not a compiled binary; update the checkout instead",
      );
    }
    binary = prefix.command;
    source = "this process";
  }
  return { binary, source };
}

/**
 * The download URL with its query string removed, for putting in a message.
 *
 * **The query carries a live credential.** The plane bakes a single-use
 * `?update_token=nut_…` into the URL it sends (spec §5.3), and every refusal
 * below names the URL it was working on — which is right, since "which address
 * could not be reached" is the whole diagnosis. But those sentences travel:
 * the executor logs one into `<configHome>/logs/agent.log`, which any node
 * owner or `edit` grantee reads over HTTP, and a token in a log file outlives
 * the ten minutes that were supposed to bound it.
 *
 * So the address is kept and the credential is dropped, here, at the ONE place
 * these sentences are built — rather than at each place one might be printed,
 * which is the arrangement that eventually misses one.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // Not a URL we can parse is not a URL we can redact: say nothing rather
    // than echo something that might carry a token after a `?` we did not
    // understand.
    return "the download url";
  }
}

/**
 * Download to `<dir>/<basename>.download-<pid>`, hashing as the bytes arrive.
 *
 * Streamed rather than buffered for the obvious reason (the artifact is ~70 MB
 * and a node may be a small machine), and hashed IN the same pass so nothing
 * unverified is ever on disk longer than the transfer. A mismatch deletes the
 * partial file before throwing — the check is what makes the later `chmod +x`
 * sound, so there must be nothing left for a confused hand to run.
 *
 * Every refusal names {@link redactUrl}'s answer, never the URL as given: the
 * query string is a single-use credential and these sentences are logged.
 *
 * @returns the lowercase-hex digest of what arrived — {@link applyUpdate}
 *   compares it AGAINST the signed manifest as the deciding check; this
 *   function's own comparison is against the digest the command named, which
 *   is the belt, not the anchor (spec 2026-09-17 §4).
 */
async function download(url: string, expected: string, dest: string): Promise<string> {
  const shown = redactUrl(url);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new UpdateRefused(
      NODE_RESULT_DOWNLOAD_FAILED,
      `${shown} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok || response.body === null) {
    throw new UpdateRefused(NODE_RESULT_DOWNLOAD_FAILED, `${shown} answered ${response.status}`);
  }
  const sink = Bun.file(dest).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let seen = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      seen += chunk.byteLength;
      if (seen > MAX_UPDATE_BYTES) throw new Error(`exceeded ${MAX_UPDATE_BYTES} bytes`);
      hasher.update(chunk);
      sink.write(chunk);
    }
    await sink.end();
  } catch (err) {
    try {
      await sink.end();
    } catch {
      /* already ended, or never opened */
    }
    await rm(dest, { force: true }).catch(() => {});
    throw new UpdateRefused(
      NODE_RESULT_DOWNLOAD_FAILED,
      `${shown} failed mid-transfer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const actual = hasher.digest("hex");
  if (actual !== expected.toLowerCase()) {
    await rm(dest, { force: true }).catch(() => {});
    throw new UpdateRefused(
      NODE_RESULT_DIGEST_MISMATCH,
      `${shown} did not match the published digest (expected ${expected}, got ${actual})`,
    );
  }
  return actual;
}

/**
 * Publisher-verification seams. Tests replace these; the protocol package's
 * fixture trio pins what the real pair does against genuine `tauri signer`
 * output. BOTH call sites — the executor's {@link verifySignedManifest} and
 * the CLI's {@link resolveNodeRelease} — go through this object, whose
 * defaults are exactly what production ships: one implementation, two call
 * sites, per the spec's whole premise, and one seam where a test can stand in
 * for the crypto without leaving either call site unreachable.
 * @internal
 */
export const updateSeams = {
  verifyManifest: verifyReleaseManifest,
  pubkey: RELEASE_PUBKEY,
};

/**
 * The rule of spec 2026-09-17 §4, in one function: bytes are installable iff
 * they hash to the digest the SIGNED manifest names for this host's exact
 * published filename, and that manifest's signature verifies against the
 * compiled-in publisher pubkey with a payload naming component `node` and
 * exactly the version being installed.
 *
 * Runs AFTER the download and BEFORE the swap (and before the first
 * `chmod +x`'s subject exists as anything but a temp file) — the spec's own
 * words, and the reason the digest the command carried is only a belt: a
 * compromised plane can order an update, but it cannot make this agent accept
 * a manifest the publisher did not sign. Node-signing key ⇒ ordering;
 * publisher key ⇒ payload; neither implies the other.
 *
 * @throws {@link UpdateRefused} — `manifest` absent or unverifiable answers
 *   {@link NODE_RESULT_MANIFEST_UNVERIFIED}; a digest the manifest does not
 *   name, or names differently, answers the digest constant. The plane maps
 *   both by equality; the sentence is logged here, where the node's owner can
 *   read it.
 */
async function verifySignedManifest(
  source: Extract<UpdateSource, { kind: "url" }>,
  actualDigest: string,
  version: string,
): Promise<void> {
  if (source.manifest === null) {
    throw new UpdateRefused(
      NODE_RESULT_MANIFEST_UNVERIFIED,
      "the update carried no signed release manifest, so this agent will not install bytes it cannot tie to the publisher",
    );
  }
  const target = hostReleaseTarget(process.platform, process.arch);
  if (target === null) {
    throw new UpdateRefused(
      NODE_RESULT_DIGEST_MISMATCH,
      `this host (${process.platform}/${process.arch}) has no published artifact name, so a signed digest cannot be checked against it`,
    );
  }
  const checked = await updateSeams.verifyManifest(source.manifest.bytes, source.manifest.sig, updateSeams.pubkey, {
    component: "node",
    version,
  });
  if (!checked.ok) {
    throw new UpdateRefused(
      NODE_RESULT_MANIFEST_UNVERIFIED,
      `the release manifest did not verify against the compiled-in publisher pubkey: ${checked.reason}`,
    );
  }
  const asset = releaseAssetNames("node", target).binary;
  const named = checked.manifest.assets[asset];
  if (named === undefined) {
    throw new UpdateRefused(NODE_RESULT_DIGEST_MISMATCH, `the signed manifest for ${version} names no ${asset}`);
  }
  if (named !== actualDigest) {
    throw new UpdateRefused(
      NODE_RESULT_DIGEST_MISMATCH,
      `the downloaded bytes hash to ${actualDigest}, not the ${named} the signed manifest names for ${asset}`,
    );
  }
}

/**
 * Run `<binary> version` and return the version token, or null when it said
 * nothing usable. The contract is the one the release smoke already relies on:
 * `subshell X.Y.Z (node protocol vN)`.
 */
async function defaultProbeVersion(binary: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([binary, "version"], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    return out.trim().match(/^subshell\s+(\S+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** What an applied update reports back to whoever asked. */
export interface AppliedUpdate {
  /** The version that was running. */
  from: string;
  /** The version now on disk. */
  to: string;
  /** The binary that was replaced. */
  binary: string;
  /** Whether this call drove the restart itself. */
  restarted: boolean;
  /** What to tell a person when it did not (and could not) restart. */
  note?: string;
}

/**
 * Replace this agent's binary with `version` from `source`, and optionally
 * restart into it.
 *
 * Order is the whole design, and every step is where it is for a reason:
 *
 * 1. **Resolve the binary first**, so an un-swappable install refuses before
 *    anything is downloaded.
 * 2. **Download and verify**, then `chmod 0755`, then **run `<temp> version`
 *    and require the answer** — a binary that cannot say what it is does not
 *    get installed, and that probe is also what catches a wrong-architecture
 *    artifact before it becomes the file the service manager runs.
 * 3. **Write the marker BEFORE the swap.** A crash between the marker and the
 *    rename leaves a marker naming a `.previous` that does not exist, which
 *    the revert path tolerates; a crash between the renames with no marker
 *    would leave nobody able to say what happened.
 * 4. **Two renames**, `binary → binary.previous` then `temp → binary`. A
 *    failure between them puts `.previous` back and clears the marker, because
 *    a machine with no binary at all is the one outcome nothing can recover.
 *
 * @throws {@link UpdateRefused} for every refusal the plane maps to a 409
 */
export async function applyUpdate(input: ApplyUpdateInput): Promise<AppliedUpdate> {
  const { binary, dir } = await resolveAgentBinary();
  const temp = join(dir, `${basename(binary)}.download-${process.pid}`);
  const previous = `${binary}.previous`;

  if (input.source.kind === "url") {
    const actualDigest = await download(input.source.url, input.source.sha256, temp);
    // The publisher check the command channel alone could never give this
    // machine (§4), before the chmod, before the marker, before anything.
    // A refusal deletes the temp file: the rule is "nothing unverified sits
    // on disk", and a refusal mid-way is exactly when a stray file would.
    try {
      await verifySignedManifest(input.source, actualDigest, input.version);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  } else {
    try {
      await copyFile(input.source.path, temp);
    } catch (err) {
      throw new UpdateRefused(
        NODE_RESULT_DOWNLOAD_FAILED,
        `cannot copy ${input.source.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    await chmod(temp, 0o755);
    const probe = input.probeVersion ?? defaultProbeVersion;
    const reported = await probe(temp);
    if (reported !== input.version) {
      throw new UpdateRefused(
        NODE_RESULT_VERSION_MISMATCH,
        `the downloaded binary reports ${reported ?? "nothing"}, not ${input.version}`,
      );
    }
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }

  const marker: UpdateMarker = {
    from: AGENT_VERSION,
    to: input.version,
    binary,
    previousBinary: previous,
    startedAt: new Date().toISOString(),
    origin: input.origin,
  };
  await writeMarker(pendingMarkerPath(input.dataDir), marker);

  // The two renames. Between them this machine has no agent binary at
  // `binary`, which is the only window worth unwinding by hand.
  await rm(previous, { force: true }).catch(() => {});
  await rename(binary, previous);
  try {
    await rename(temp, binary);
  } catch (err) {
    await rename(previous, binary).catch(() => {});
    await rm(pendingMarkerPath(input.dataDir), { force: true }).catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw new UpdateRefused(
      NODE_RESULT_DOWNLOAD_FAILED,
      `could not install the new binary at ${binary}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log(`installed subshell ${input.version} at ${binary} (previous kept at ${previous})`);

  if (!input.restart) {
    return { from: AGENT_VERSION, to: input.version, binary, restarted: false };
  }

  if (!input.restartService) {
    return {
      from: AGENT_VERSION,
      to: input.version,
      binary,
      restarted: false,
      note: "restart it where you started it",
    };
  }
  const res = await input.restartService(input.force === true);
  if (res.code !== 0) {
    return {
      from: AGENT_VERSION,
      to: input.version,
      binary,
      restarted: false,
      note: (res.err.trim() || res.out.trim() || "the service manager refused the restart").split("\n")[0] ?? "",
    };
  }
  return { from: AGENT_VERSION, to: input.version, binary, restarted: true };
}

/**
 * The 4406 rollback (spec §5.2 step 5) — the node's whole recovery path.
 *
 * A control plane that refuses a freshly-installed agent has said the only
 * thing that matters: the version just installed cannot talk to it. So the
 * previous binary goes back, the failure is recorded for whoever looks, and
 * the caller exits 1 for the service manager to respawn what was there before.
 *
 * With NO marker this does nothing and the daemon's existing 4406 behaviour
 * (log and exit) stands — a plane refusing an agent nobody just updated is the
 * ordinary "your node is too old" case and swapping files there would be
 * inventing a rollback for an update that never happened.
 *
 * @returns the failure it recorded, or null when there was nothing to revert
 */
export async function revertAfterRefusal(dataDir: string, reason: string): Promise<UpdateFailure | null> {
  const pending = await readMarker(pendingMarkerPath(dataDir));
  if (!pending) return null;
  try {
    const info = await stat(pending.previousBinary);
    if (!info.isFile()) return null;
  } catch {
    // The marker names a `.previous` that is gone (a crash between the
    // renames, or a hand that tidied up). There is nothing to put back, so say
    // so rather than deleting the marker and pretending the update succeeded.
    log(
      `the control plane refused subshell ${pending.to} and there is no ${pending.previousBinary} to restore; reinstall the agent by hand`,
    );
    return null;
  }
  await rename(pending.previousBinary, pending.binary);
  const failure: UpdateFailure = { ...pending, reason, failedAt: new Date().toISOString() };
  await writeMarker(failedMarkerPath(dataDir), failure);
  await rm(pendingMarkerPath(dataDir), { force: true }).catch(() => {});
  log(`rolled back to subshell ${pending.from}: the control plane refused ${pending.to} (${reason})`);
  return failure;
}

/**
 * The other end of the transaction: the plane ACCEPTED this agent, so the
 * update is finished — drop `.previous` and the marker.
 *
 * "Accepted" is not a frame the plane sends; §5.1 defines it as any frame
 * arriving after `ready`, or the socket simply staying open. Both mean the
 * gates passed, because a refusal is immediate. The daemon owns deciding
 * that; this function owns the cleanup, and is idempotent so deciding twice
 * costs nothing.
 */
export async function completeUpdate(dataDir: string): Promise<UpdateMarker | null> {
  const pending = await readMarker(pendingMarkerPath(dataDir));
  if (!pending) return null;
  await rm(pending.previousBinary, { force: true }).catch(() => {});
  await rm(pendingMarkerPath(dataDir), { force: true }).catch(() => {});
  log(`update to subshell ${pending.to} accepted by the control plane; removed ${pending.previousBinary}`);
  return pending;
}

/**
 * `subshell update --rollback`: put `<binary>.previous` back by hand.
 *
 * Distinct from {@link revertAfterRefusal} in what it reads — that one is
 * driven by a refusal and consumes the pending marker; this one is driven by a
 * person who watched the new version misbehave in some way the plane was happy
 * with, and works from whichever marker is on disk (or from neither, when the
 * `.previous` is simply there).
 */
export async function rollbackUpdate(dataDir: string): Promise<{ binary: string; to: string }> {
  const { binary } = await resolveAgentBinary();
  const previous = `${binary}.previous`;
  try {
    const info = await stat(previous);
    if (!info.isFile()) throw new Error("not a regular file");
  } catch {
    throw new UpdateRefused(
      NODE_RESULT_NOT_COMPILED,
      `there is no ${previous} to roll back to — an update either never ran here or was already accepted`,
    );
  }
  const marker =
    (await readMarker(pendingMarkerPath(dataDir))) ?? (await readMarker<UpdateFailure>(failedMarkerPath(dataDir)));
  // ONE rename, no `rm` in front of it. `rename(2)` replaces an existing
  // destination atomically, so unlinking first buys nothing and opens exactly
  // the window this module's own comments call the one outcome nothing can
  // recover: an interruption between the two left a machine with no agent
  // binary at all and no `.previous` either.
  await rename(previous, binary);
  await rm(pendingMarkerPath(dataDir), { force: true }).catch(() => {});
  return { binary, to: marker?.from ?? "the previous version" };
}

/* ------------------------------------------------------------------ */
/* the CLI's release source                                            */
/* ------------------------------------------------------------------ */

/**
 * Where `subshell update` reads releases from, or null when this host fetches
 * nothing.
 *
 * `SUBSHELL_RELEASE_URL` is the one seam, exactly as on the server: set, it
 * replaces the address; set EMPTY, it means air-gapped and every network read
 * in this module refuses with a line pointing at `--from`. Unset is the
 * ordinary case and resolves to the project's own release API.
 *
 * The name is shared with the server deliberately (spec §3.3): when
 * `downloads.subshell.sh` exists it serves the same JSON shape at the same
 * variable, and neither side changes.
 */
export function releaseApiUrl(): string | null {
  const configured = process.env.SUBSHELL_RELEASE_URL;
  if (configured === undefined) return DEFAULT_RELEASE_API;
  const trimmed = configured.trim();
  return trimmed === "" ? null : trimmed;
}

/** One node release this machine could install, resolved down to a URL and a digest. */
export interface NodeReleaseOffer {
  /** Version of the release. */
  version: string;
  /** Its git tag. */
  tag: string;
  /** Download URL of the artifact for THIS host's triple. */
  url: string;
  /**
   * Lowercase-hex sha256 the bytes must hash to — the digest the VERIFIED
   * signed manifest names for this host's exact published filename, never the
   * one the `.sha256` sidecar carries (spec 2026-09-17 §4).
   */
  sha256: string;
  /** The manifest + signature that produced `sha256`, to be verified again inside {@link applyUpdate}. */
  manifest: UpdateManifestSource;
}

/** A GitHub release entry, narrowed to the two fields this reader uses. */
interface ReleasePayloadEntry {
  tag_name?: unknown;
  draft?: unknown;
  assets?: unknown;
}

/**
 * The node release this machine should install, from the release list.
 *
 * **This CLI cannot ask its own control plane which version is compatible** —
 * a node key does nothing on REST (security §5.5), so there is no credential
 * with which to read the plane's compatibility answer. So the honest default
 * is the NEWEST node release, and the caller prints the line saying where the
 * sharper answer lives (`Settings → Updates`, which knows the plane's
 * protocol). `--to` is how a person acts on having read it.
 *
 * @param want - an exact version to install, or undefined for the newest
 * @throws when the source is disabled, unreachable, or has no asset for this host
 */
export async function resolveNodeRelease(want?: string): Promise<NodeReleaseOffer> {
  const api = releaseApiUrl();
  if (api === null) {
    throw new Error("this host fetches no releases (SUBSHELL_RELEASE_URL is empty); install a file with --from");
  }
  const target = hostReleaseTarget(process.platform, process.arch);
  if (target === null) {
    throw new Error(`no subshell artifact is published for ${process.platform}/${process.arch}`);
  }

  let payload: unknown;
  try {
    const response = await fetch(api, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    payload = await response.json();
  } catch (err) {
    throw new Error(`could not read the releases from ${api}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(payload)) throw new Error(`${api} did not answer a list of releases`);

  const byTag = new Map<string, Map<string, string>>();
  for (const entry of payload as ReleasePayloadEntry[]) {
    if (entry?.draft === true) continue;
    const tag = typeof entry?.tag_name === "string" ? entry.tag_name : null;
    if (tag === null) continue;
    const assets = new Map<string, string>();
    for (const asset of Array.isArray(entry.assets) ? entry.assets : []) {
      const { name, browser_download_url: url } = (asset ?? {}) as { name?: unknown; browser_download_url?: unknown };
      if (typeof name === "string" && typeof url === "string") assets.set(name, url);
    }
    byTag.set(tag, assets);
  }

  const tags = [...byTag.keys()];
  const chosen = want
    ? (tags.map((tag) => ({ tag, version: parseReleaseTag("node", tag) })).find((c) => c.version === want) ?? null)
    : newestRelease("node", tags);
  if (chosen === null || chosen.version === null) {
    throw new Error(want ? `${api} publishes no node release ${want}` : `${api} publishes no node-v* release`);
  }
  const assets = byTag.get(chosen.tag) ?? new Map<string, string>();
  const { binary } = releaseAssetNames("node", target);
  const url = assets.get(binary);
  if (!url) throw new Error(`${chosen.tag} publishes no ${binary}`);

  // The signed manifest, not the sidecar, is the trust anchor (spec
  // 2026-09-17 §4): fetch both tiny assets, verify the publisher signature
  // against the compiled-in pubkey with the payload bound to THIS component
  // and version, and take the digest from the signed map. Verifying here —
  // before ~70 MB is downloaded — means a release the publisher never signed
  // costs this machine two small reads, and it is the CLI's own answer: a
  // node holds no REST credential, so it checks the publisher directly rather
  // than asking its plane (which is precisely the split §4 draws).
  const manifestUrl = assets.get(RELEASE_MANIFEST_NAME);
  const sigUrl = assets.get(RELEASE_MANIFEST_SIG_NAME);
  if (!manifestUrl) {
    throw new Error(
      `${chosen.tag} publishes no ${RELEASE_MANIFEST_NAME}, so this release cannot be verified — install a file with --from`,
    );
  }
  if (!sigUrl) {
    throw new Error(
      `${chosen.tag} publishes no ${RELEASE_MANIFEST_SIG_NAME}, so this release is not signed — install a file with --from`,
    );
  }
  let bytes: string;
  let sig: string;
  try {
    const [manifestRes, sigRes] = await Promise.all([
      fetch(manifestUrl, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }),
      fetch(sigUrl, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }),
    ]);
    if (!manifestRes.ok) throw new Error(`${RELEASE_MANIFEST_NAME} answered ${manifestRes.status}`);
    if (!sigRes.ok) throw new Error(`${RELEASE_MANIFEST_SIG_NAME} answered ${sigRes.status}`);
    bytes = await manifestRes.text();
    sig = await sigRes.text();
  } catch (err) {
    throw new Error(
      `could not read the release manifest from ${chosen.tag}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const checked = await updateSeams.verifyManifest(bytes, sig, updateSeams.pubkey, {
    component: "node",
    version: chosen.version,
  });
  if (!checked.ok) throw new Error(`${chosen.tag} is not installable: ${checked.reason}`);
  const sha256 = checked.manifest.assets[binary];
  if (sha256 === undefined) throw new Error(`${chosen.tag}'s signed manifest names no ${binary}`);

  return { version: chosen.version, tag: chosen.tag, url, sha256, manifest: { bytes, sig } };
}

/**
 * The version a local file reports, for `--from`.
 *
 * There is no digest to check on a path the operator (or the desktop app)
 * named, so the binary's OWN answer is the contract — the same
 * `subshell X.Y.Z` line the release smoke matches — and it is read BEFORE the
 * transaction so `--from` can report a version it never had to be told.
 */
export async function probeFileVersion(path: string): Promise<string> {
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode;
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Executable already, or made so for the probe only — the file the operator
  // named is never chmod-ed here; `applyUpdate` chmods its own COPY.
  if (mode !== undefined && (mode & 0o111) === 0) {
    throw new Error(`${path} is not executable, so it cannot be asked for its version`);
  }
  const reported = await defaultProbeVersion(path);
  if (reported === null) throw new Error(`${path} did not answer \`subshell version\`; it is not a subshell binary`);
  return reported;
}
