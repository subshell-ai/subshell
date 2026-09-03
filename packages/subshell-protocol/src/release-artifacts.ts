/**
 * Shared release-artifact primitives (spec 2026-09-03 §5): the streaming
 * digest + the atomic tmp+rename publish that BOTH apps' `compile:release`
 * pipelines use. Lives here beside NODE_TARGETS for the same reason — the
 * apps never import each other.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { nodeArtifactFileName } from "./paths.js";

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
 * @param artifacts - triple → built artifact map assembled by the caller's
 *   build phase — both apps' release pipelines call this only on a complete build
 * @param destDir - directory to publish into (created when missing)
 */
export async function publishArtifacts(artifacts: Map<string, BuiltArtifact>, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const [triple, { path, digest }] of artifacts) {
    const dest = join(destDir, nodeArtifactFileName(triple));
    const tmp = `${dest}.tmp-${process.pid}`;
    await copyFile(path, tmp);
    await rename(tmp, dest);
    await Bun.write(`${dest}.sha256`, `${digest}\n`);
  }
}
