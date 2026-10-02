import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { NodeCommandBody } from "@internal/subshell-protocol";
import { log } from "../log.js";
import { pathAllowed } from "../path-policy.js";
import { receiveChunkedStream } from "./chunked-stream.js";
import type { CommandContext, CommandResult } from "./context.js";

/**
 * The `write_file` chunk receiver (spec 2026-08-31 §3.4): the terminal-upload
 * relay delivers a file as ordered base64 chunks + an `eof` flag. The stream
 * discipline (temp-beside-final `.part`, in-order chunks, gate-twice,
 * rename-last) lives in `chunked-stream.ts`, shared VERBATIM with
 * `transfer_write`; this module owns only the uploads policy.
 *
 * That policy is deliberately NOT the transfers one, and the two are not
 * mergeable: `write_file`'s roots are dataDir + tracked working dirs, gated
 * twice and pinned by tests as the narrow upload surface; widening them to
 * reach a transfer destination would weaken a load-bearing policy (spec
 * 2026-10-01 §4 says keep them apart, which is why the sibling verb carries a
 * different name). Every accepted chunk answers the {@link NodeWriteFileResult}
 * shape `{ path, received }` with `received` the running total, so the control
 * plane can assert `received === file.size` on the eof answer (backend-side
 * verify, Task 12). Stream state lives on `ctx.uploads` — per-daemon, survives
 * reconnects, never leaves the process.
 */

/** Narrowing alias for the write_file command body. */
type Cmd = Extract<NodeCommandBody, { type: "write_file" }>;

/** Age past which an orphaned `.part` temp is swept at daemon start (spec §3.4). */
const STALE_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * The write_file policy roots, recomputed on EVERY call (never cached):
 * `<dataDir>` + every tracked subshell's launch cwd (spec §7). Fresh by
 * construction, because both the cwd set and the symlinks beneath it drift
 * during a long-lived stream.
 */
async function policyRoots(ctx: CommandContext): Promise<string[]> {
  return [ctx.config.dataDir, ...(await ctx.meta.list()).map((m) => m.cwd)];
}

/**
 * `write_file` (spec §3.4): receive one chunk of a chunked upload, gated
 * against {@link policyRoots} on chunk 0 and again at eof (semantics:
 * `chunked-stream.ts`).
 *
 * @param ctx - the per-daemon context (`uploads` is this executor's map)
 * @param cmd - the verified `write_file` command body
 * @returns `{ path, received }` on every accepted chunk; `path refused: …` /
 *   `write_file chunk <N> has no open stream` otherwise
 */
export async function execWriteFile(ctx: CommandContext, cmd: Cmd): Promise<CommandResult> {
  return await receiveChunkedStream(
    ctx,
    cmd.path,
    Buffer.from(cmd.chunk_b64, "base64"),
    cmd.chunk,
    cmd.eof,
    "write_file",
    async (path) => await pathAllowed(path, await policyRoots(ctx)),
  );
}

/**
 * Sweep orphaned upload temps at daemon startup (spec §3.4): a crash between
 * chunk 0 and eof leaves a `.part` behind, so every boot deletes
 * `.*.part` REGULAR FILES older than {@link STALE_UPLOAD_MAX_AGE_MS} in
 * `<dataDir>` and each tracked subshell's cwd. The scan is deliberately
 * SHALLOW (top-level entries of those dirs only — cheaply enumerable at boot);
 * deeper strays are harmless until a same-named restart truncates them.
 * Missing/unreadable directories are skipped silently and the function NEVER
 * throws — a broken sweep must not cost the node its connection.
 *
 * @param ctx - the per-daemon context (dataDir, meta store, clock all read from here)
 */
export async function cleanupStaleUploads(ctx: CommandContext): Promise<void> {
  try {
    const dirs = [ctx.config.dataDir, ...(await ctx.meta.list()).map((m) => m.cwd)];
    const now = ctx.nowMs();
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue; // missing (or not a directory) — nothing enumerable, nothing to sweep
      }
      for (const name of names) {
        if (!name.startsWith(".") || !name.endsWith(".part")) continue; // only OUR temp naming
        const path = join(dir, name);
        try {
          const st = await lstat(path); // lstat: never chase a planted symlink to someone else's file
          if (!st.isFile()) continue;
          if (now - st.mtimeMs < STALE_UPLOAD_MAX_AGE_MS) continue; // still a live stream from a pre-restart life? give it the hour
          await unlink(path);
        } catch {
          // vanished mid-scan / unlinked by a concurrent chunk — best effort
        }
      }
    }
  } catch (err) {
    log(`stale-upload sweep failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}
