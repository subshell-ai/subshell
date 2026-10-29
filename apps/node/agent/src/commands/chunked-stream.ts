import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type JsonValue, type NodeWriteFileResult, partPathOf } from "@internal/subshell-protocol";
import type { CommandContext, CommandResult, UploadState } from "./context.js";

/**
 * The chunked-write stream core shared by `write_file` (terminal uploads,
 * spec 2026-08-31 §3.4) and `transfer_write` (archive relay, spec 2026-10-01
 * §4). The two commands answer through ONE implementation because their
 * discipline is identical and was battle-tested once: bytes accumulate in a
 * `.<basename>.part` temp BESIDE the final path (same filesystem, so the eof
 * rename can never hit EXDEV). Both paths are gated before writing and again
 * at eof because symlinks and roots drift mid-stream. Each write checks the
 * opened inode before changing it. Chunks arrive in order; eof renames once.
 *
 * What deliberately differs is passed IN: `gate` is the per-command POLICY
 * (uploads: dataDir + tracked cwds; transfers: the operator allowlist). The
 * two policies are load-bearing in opposite directions and must never be
 * merged, which is also why the commands carry different names.
 */

/** Per-command policy: whether this path may receive a stream right now. */
export type StreamGate = (path: string) => Promise<boolean>;

/** Check the opened inode before truncating, appending, or changing its mode. */
async function writeChunk(path: string, bytes: Uint8Array, first: boolean): Promise<boolean> {
  let file;
  try {
    file = await open(
      path,
      constants.O_WRONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (first ? constants.O_CREAT : constants.O_APPEND),
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") return false;
    throw err;
  }
  try {
    const info = await file.stat();
    // O_NOFOLLOW cannot detect hard links. O_TRUNC at open would already
    // damage the shared inode before this check could refuse it.
    if (!info.isFile() || info.nlink !== 1) return false;
    if (first) await file.truncate(0);
    await file.chmod(0o600);
    await file.writeFile(bytes);
    return true;
  } finally {
    await file.close();
  }
}

/**
 * Receive one chunk of a chunked stream. All refusal paths answer `ok:false`
 * and change no stream state except where the caller's own doc notes them:
 * - chunk 0 (re)starts a stream: gate BEFORE any side effect, `mkdir -p` the
 *   parent, (re)create the temp at 0600. Restart over an open stream deletes
 *   the old temp first (the mid-stream-failure self-heal the relays rely on).
 * - chunk N>0 requires an open stream whose `expectedChunk === N`; the stream
 *   stays open on a sequencing refusal so the plane can redeliver the right
 *   index. A path or inode refusal discards it before any bytes are appended.
 * - eof RE-CHECKS the gate on fresh facts, re-creates a vanished parent,
 *   renames temp→final (replacing any existing file, retaining mode 0600),
 *   and drops the stream. An eof refusal deletes the temp — nothing stranded.
 *
 * @param ctx - the per-daemon context (`uploads` holds this stream's state)
 * @param rawPath - the final destination path as the command carried it
 * @param bytes - this chunk's decoded bytes
 * @param chunk - zero-based chunk index
 * @param eof - true on the last chunk
 * @param label - the command's wire name, for refusal strings
 * @param gate - the per-command policy check
 * @returns `{ path, received }` (the NodeWriteFileResult shape) on every
 *   accepted chunk; a refusal otherwise
 */
export async function receiveChunkedStream(
  ctx: CommandContext,
  rawPath: string,
  bytes: Uint8Array,
  chunk: number,
  eof: boolean,
  label: string,
  gate: StreamGate,
): Promise<CommandResult> {
  const key = resolve(rawPath);
  const existing = ctx.uploads.get(key);
  let state: UploadState;

  if (chunk === 0) {
    // Gate BEFORE any side effect: a refused path creates no dir, no temp.
    if (!(await gate(rawPath))) {
      return { ok: false, error: `path refused: ${rawPath}` };
    }
    if (existing) {
      ctx.uploads.delete(key); // restart: the old temp is replaced below (or by the sweep if we throw here)
      try {
        await unlink(existing.tmpPath);
      } catch {
        // A missing temp is fine; any surviving inode is checked below.
      }
    }
    await mkdir(dirname(key), { recursive: true });
    // The shared derivation (protocol package): the plane's abort cleanup and
    // the sweep compute the SAME name from code they both import, so this
    // writer cannot drift out of either.
    const tmpPath = partPathOf(key);
    if (!(await gate(tmpPath)) || !(await writeChunk(tmpPath, bytes, true))) {
      return { ok: false, error: `path refused: ${rawPath}` };
    }
    state = { tmpPath, received: bytes.byteLength, expectedChunk: 1 };
    ctx.uploads.set(key, state);
  } else {
    if (!existing || chunk !== existing.expectedChunk) {
      return { ok: false, error: `${label} chunk ${chunk} has no open stream` };
    }
    // The destination check alone says nothing about the predictable .part
    // leaf. Recheck both paths before every write, not only after the bytes
    // have already followed a replaced parent or temporary-file link.
    if (
      !(await gate(rawPath)) ||
      !(await gate(existing.tmpPath)) ||
      !(await writeChunk(existing.tmpPath, bytes, false))
    ) {
      await discard(ctx, key);
      return { ok: false, error: `path refused: ${rawPath}` };
    }
    existing.received += bytes.byteLength;
    existing.expectedChunk += 1;
    state = existing;
  }

  if (!eof) return okData(rawPath, state.received);

  // eof: the world may have changed since chunk 0 — re-gate the final path
  // (the hardened policy catches `..`, ancestor symlinks, and any symlink
  // leaf planted mid-stream) before the rename can land bytes.
  if (!(await gate(rawPath)) || !(await gate(state.tmpPath))) {
    await discard(ctx, key);
    return { ok: false, error: `path refused: ${rawPath}` };
  }
  await mkdir(dirname(key), { recursive: true }); // parent may have been deleted mid-stream
  await rename(state.tmpPath, key); // POSIX rename: replaces an existing final, preserves the 0600 mode
  // writeChunk set the mode through its checked descriptor; rename retains it.
  ctx.uploads.delete(key);
  return okData(rawPath, state.received);
}

/** The shared answer shape, seam-cast like every other executor (JsonValue index signature). */
function okData(path: string, received: number): CommandResult {
  const data: NodeWriteFileResult = { path, received };
  return { ok: true, data: data as unknown as JsonValue };
}

/** Best-effort: delete a stream's temp and drop its state (eof failure / restart). */
async function discard(ctx: CommandContext, key: string): Promise<void> {
  const state = ctx.uploads.get(key);
  if (!state) return;
  ctx.uploads.delete(key);
  try {
    await unlink(state.tmpPath);
  } catch {
    // already gone (or the dir moved under us) — the startup sweep is the backstop
  }
}
