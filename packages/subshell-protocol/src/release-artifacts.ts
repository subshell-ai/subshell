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
