/**
 * Shared release-artifact primitives (spec 2026-09-03 §5): the streaming
 * digest + the atomic tmp+rename publish that BOTH apps' `compile:release`
 * pipelines use, plus the shared schedule/scoping helpers the two pipelines
 * were duplicating (plan 2 Task E): the {@link parseScope} env override and
 * the {@link assertBunFloor} bytecode-version guard. (The semver comparator
 * that used to sit between them moved to `./versions.js`, which the agent
 * floor also needs and which — unlike this module — imports no node builtins,
 * so it can live on the Metro-safe barrel.)
 * Lives here beside NODE_TARGETS for the same reason — the apps never
 * import each other. Node builtins only (like the rest of this module), so it
 * stays OFF the Metro-safe barrel; pipelines import the subpath.
 *
 * {@link selectBundleOutput} joins them for the two desktop pipelines: the
 * bundle directory is GLOBBED for the one artifact Tauri wrote, rather than
 * that name being predicted from `productName`.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { semverLt } from "./versions.js";

/**
 * Streaming sha256 (lowercase hex) of a file — the ~100 MB compiled binaries
 * never enter memory. Reusable so tests digest with the PRODUCTION helper
 * instead of mirroring the hasher expression.
 */
export async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Env var both release pipelines consult for the optional post-build signing
 * hook (see {@link runSignHook}). CI sets it ONLY on darwin shards, to
 * `scripts/macos-sign-notarize.sh`; an unset/blank value is the normal
 * no-op (local builds, linux shards).
 */
export const RELEASE_SIGN_CMD_ENV = "SUBSHELL_RELEASE_SIGN_CMD";

/**
 * Optional post-build signing/notarization hook, run on each freshly built
 * artifact BEFORE it is digested — so the published `.sha256` sidecar always
 * describes the FINAL (signed) bytes, and a signing failure is just another
 * target failure (nothing publishes).
 *
 * The hook is a shell command from {@link RELEASE_SIGN_CMD_ENV}. The artifact
 * path is APPENDED to it as one properly-quoted argument (so a bare script
 * path — the shape CI sets — just works; the script sees the artifact as its
 * own `$1`). stdout/stderr flow through: the notarytool submission log
 * belongs in the CI output.
 * @param path - the built artifact to sign, in place
 * @param env - environment source (default `process.env`)
 * @returns true when the artifact may proceed to digest/publish
 */
export async function runSignHook(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const cmd = env[RELEASE_SIGN_CMD_ENV];
  if (cmd === undefined || cmd.trim() === "") return true;
  const proc = Bun.spawn(["sh", "-c", `${cmd} "$1"`, "sign-hook", path], { stdout: "inherit", stderr: "inherit" });
  return (await proc.exited) === 0;
}

/** A compiled, digested artifact awaiting publication. */
export interface BuiltArtifact {
  /** Absolute path of the built file inside `outDir`. */
  path: string;
  /** Lowercase 64-hex sha256 of the file's bytes. */
  digest: string;
}

/**
 * Publishes artifacts to `destDir`: `copyFile → <name>.tmp-<pid> → rename` so
 * the downloads route's mtime-keyed sha cache can never observe a half-written
 * binary, plus a freshly generated `.sha256` sidecar (64-hex + `\n`) per
 * target — a stale sidecar is always overwritten, never reused.
 *
 * ATOMICITY IS PER-FILE: the binary swap is atomic, the sidecar write is not,
 * so a download landing in the window between them can pair a new binary with
 * the previous digest. That fails SAFE (install.sh's digest check refuses the
 * exec; a retry gets the pair) on a rare operator-published path — noted so
 * the atomicity claim is never stronger than the mechanism.
 *
 * The published NAME is the artifact file's OWN basename (each pipeline names
 * its outputs via `nodeArtifactFileName`/`serverArtifactFileName` at build
 * time) — publish mirrors the build, so the two binaries can share this
 * primitive without sharing a name pattern.
 * @param artifacts - caller-keyed artifact map assembled by the build phase
 *   (client keys by triple; the server keys by artifact file name, two per
 *   triple — publish reads only `basename(path)`, never the key) — both apps'
 *   release pipelines call this only on a complete build
 * @param destDir - directory to publish into (created when missing)
 */
export async function publishArtifacts(artifacts: Map<string, BuiltArtifact>, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const [, { path, digest }] of artifacts) {
    const dest = join(destDir, basename(path));
    const tmp = `${dest}.tmp-${process.pid}`;
    await copyFile(path, tmp);
    await rename(tmp, dest);
    await Bun.write(`${dest}.sha256`, `${digest}\n`);
  }
}

/**
 * Parse a release-triples scope override (a `SUBSHELL_*_RELEASE_TRIPLES` env
 * value): whitespace-separated triples, each unknown → hard refusal (a typo'd
 * scope silently publishing a partial set is exactly the half-release the
 * pipelines exist to prevent). Generalized from the client pipeline (plan 2
 * Task E) so both apps share one parse and one refusal shape.
 * @param raw - the env value verbatim (undefined/blank → the full set)
 * @param knownTargets - the app's closed target set (NODE_TARGETS / SERVER_TARGETS)
 * @param envName - the variable `raw` came from, named in the refusal so the
 *   operator sees WHICH env to fix
 * @returns null when unset/blank (the full set)
 */
export function parseScope(raw: string | undefined, knownTargets: readonly string[], envName: string): string[] | null {
  const parts = (raw ?? "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (!knownTargets.includes(p)) {
      throw new Error(`unknown target "${p}" in ${envName} (known: ${knownTargets.join(" ")})`);
    }
  }
  return parts;
}

/**
 * Refuses (throws) a bun older than the version the bytecode-cross spike
 * proved — every release target ships `--bytecode`, so the floor guards BOTH
 * pipelines (spec 2026-09-03 §5, risk #9 retired at 1.4.0).
 * @param minimum - the floor version, e.g. `"1.4.0"`
 * @param version - version to test (default: the running bun)
 */
export function assertBunFloor(minimum: string, version: string = process.versions.bun): void {
  if (semverLt(version, minimum)) {
    throw new Error(`release builds need bun ${minimum} or newer (bytecode cross-compiles); found ${version}`);
  }
}

/**
 * Pick the ONE artifact a Tauri bundler emitted into a bundle directory.
 *
 * The desktop pipelines used to PREDICT this name from `productName`, which is
 * why both product names were single tokens: Tauri derives the `.deb` file
 * name from `productName` through Debian's own package-name sanitizer, so any
 * name that needed sanitizing was a guess only the Linux bundler could settle.
 * Discovering the name instead retires the guess — and with it the constraint
 * on what the apps may be called.
 *
 * Exactly one match, or a refusal: zero means the bundler wrote something this
 * code does not recognise (a Tauri upgrade moving the layout), and more than
 * one means the choice is ambiguous. Picking the first of several would publish
 * an arbitrary artifact under a canonical name — the one outcome worse than
 * failing the cut, because it looks like a success.
 *
 * @param entries - directory entry names of `bundle/<dir>` (as read, unsorted)
 * @param suffix - what the artifact's name ends with: `.deb` or `.app`
 * @param where - the directory, named in the refusal so an operator can look
 * @returns the single matching entry name, verbatim (spaces included)
 */
export function selectBundleOutput(entries: readonly string[], suffix: string, where: string): string {
  const matches = entries.filter((e) => e.endsWith(suffix));
  if (matches.length === 1) return matches[0] as string;
  const listing = entries.length > 0 ? entries.join(", ") : "(empty)";
  if (matches.length === 0) {
    throw new Error(`no ${suffix} in ${where} — the bundler wrote: ${listing}`);
  }
  throw new Error(
    `${matches.length} ${suffix} bundles in ${where}, expected exactly one: ${matches.join(", ")}` +
      " — refusing to publish an arbitrary one",
  );
}

/**
 * The notarization credentials, in Tauri's own env spelling — the same three
 * the release workflow exports for the desktop darwin shards and the Tauri
 * CLI itself reads: `APPLE_API_KEY_PATH` is a throwaway `.p8` materialized for
 * the run, `APPLE_API_KEY` is its Key ID, `APPLE_API_ISSUER` the issuer UUID.
 * Any one missing reads as "no notarization credentials" (local builds).
 */
export interface DmgNotaryEnv {
  /** Index signature so `process.env` passes as an env source (same shape `runSignHook` takes). */
  [key: string]: string | undefined;
  APPLE_API_KEY_PATH?: string | undefined;
  APPLE_API_KEY?: string | undefined;
  APPLE_API_ISSUER?: string | undefined;
}

/** Effects for {@link notarizeAndStapleDmg}, injected so tests run nothing. */
export interface NotaryToolDeps {
  /** Run a command to completion; resolves to its exit code and combined output. */
  runCapture: (argv: string[]) => Promise<{ code: number; output: string }>;
  log: (line: string) => void;
}

/**
 * Complete the DMG's signature chain: submit the image for notarization and
 * staple the ticket to it.
 *
 * This exists because Tauri 2.11's dmg flow SIGNS the image but neither
 * notarizes nor staples it — notarization runs against the `.app`, and a
 * user's first download is the IMAGE, which Gatekeeper assesses on its own
 * (on current macOS an unnotarized disk image is blocked outright, staple or
 * no staple inside it). So the desktop pipelines run this between the bundler
 * and the digest: the published `.sha256` describes the stapled bytes, and the
 * CI smoke's `stapler validate` on the image checks the work rather than
 * hoping.
 *
 * Two refusals, both learned elsewhere in this repo:
 * the verdict is read from notarytool's OUTPUT (`status: Accepted`), never
 * inferred from the exit code, and `stapler staple` must actually exit 0 —
 * Tauri's own staple step skips both checks, which is how a silent staple
 * failure became this module's reason to exist.
 *
 * @param dmgPath - the signed image to notarize and staple, in place
 * @param deps - runner + logger
 * @param env - credential source (default `process.env`)
 * @returns true when the image may proceed to digest/publish (accepted AND
 *   stapled, or skipped for want of credentials — CI guards the secrets
 *   separately, and the smoke fails loud if the staple is then missing)
 */
export async function notarizeAndStapleDmg(
  dmgPath: string,
  deps: NotaryToolDeps,
  env: DmgNotaryEnv = process.env,
): Promise<boolean> {
  const key = env.APPLE_API_KEY_PATH;
  const keyId = env.APPLE_API_KEY;
  const issuer = env.APPLE_API_ISSUER;
  if (!key || !keyId || !issuer) {
    deps.log("no notarization credentials (APPLE_API_KEY_PATH/-KEY/-ISSUER) — publishing the DMG UNSIGNED by Apple");
    return true;
  }
  deps.log(`notarizing ${dmgPath}…`);
  const submit = await deps.runCapture([
    "xcrun",
    "notarytool",
    "submit",
    dmgPath,
    "--key",
    key,
    "--key-id",
    keyId,
    "--issuer",
    issuer,
    "--wait",
  ]);
  if (!/status:\s*Accepted/.test(submit.output)) {
    deps.log(`notarytool did not report "status: Accepted":\n${submit.output}`);
    return false;
  }
  const staple = await deps.runCapture(["xcrun", "stapler", "staple", dmgPath]);
  if (staple.code !== 0) {
    deps.log(`stapler staple failed (exit ${staple.code}):\n${staple.output}`);
    return false;
  }
  deps.log("notarization accepted and stapled to the image");
  return true;
}
