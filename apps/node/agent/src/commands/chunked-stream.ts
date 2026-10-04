import { appendFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { enforceMode } from "@internal/pane-runtime";
import { type JsonValue, type NodeWriteFileResult, partPathOf } from "@internal/subshell-protocol";
import type { CommandContext, CommandResult, UploadState } from "./context.js";

/**
 * The chunked-write stream core shared by `write_file` (terminal uploads,
 * spec 2026-08-31 §3.4) and `transfer_write` (archive relay, spec 2026-10-01
 * §4). The two commands answer through ONE implementation because their
 * discipline is identical and was battle-tested once: bytes accumulate in a
 * `.<basename>.part` temp BESIDE the final path (same filesystem, so the eof
 * rename can never hit EXDEV), the caller's gate runs TWICE per stream (chunk
 * 0 before any parent is created, eof with fresh facts, because symlinks and
 * roots drift mid-stream), chunks must arrive in order, and eof is exactly
 * one rename to land.
 *
 * What deliberately differs is passed IN: `gate` is the per-command POLICY
 * (uploads: dataDir + tracked cwds; transfers: the operator allowlist). The
 * two policies are load-bearing in opposite directions and must never be
 * merged, which is also why the commands carry different names.
 */

/** Per-command policy: whether this path may receive a stream right now. */
export type StreamGate = (path: string) => Promise<boolean>;

/**
 * Receive one chunk of a chunked stream. All refusal paths answer `ok:false`
 * and change no stream state except where the caller's own doc notes them:
 * - chunk 0 (re)starts a stream: gate BEFORE any side effect, `mkdir -p` the
 *   parent, (re)create the temp at 0600. Restart over an open stream deletes
 *   the old temp first (the mid-stream-failure self-heal the relays rely on).
 * - chunk N>0 requires an open stream whose `expectedChunk === N`; the stream
 *   itself stays open so the control plane can redeliver the right index.
 * - eof RE-CHECKS the gate on fresh facts, re-creates a vanished parent,
 *   renames temp→final (replacing any existing file), re-tightens to 0600,
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
        // vanished mid-restart — the fresh writeFile truncates anyway
      }
    }
    await mkdir(dirname(key), { recursive: true });
    // The shared derivation (protocol package): the plane's abort cleanup and
    // the sweep compute the SAME name from code they both import, so this
    // writer cannot drift out of either.
    const tmpPath = partPathOf(key);
    await writeFile(tmpPath, bytes, { mode: 0o600 });
    await enforceMode(tmpPath, 0o600); // umask can't loosen 0600, but a pre-existing temp might have
    state = { tmpPath, received: bytes.byteLength, expectedChunk: 1 };
    ctx.uploads.set(key, state);
  } else {
    if (!existing || chunk !== existing.expectedChunk) {
      return { ok: false, error: `${label} chunk ${chunk} has no open stream` };
    }
    await appendFile(existing.tmpPath, bytes);
    existing.received += bytes.byteLength;
    existing.expectedChunk += 1;
    state = existing;
  }

  if (!eof) return okData(rawPath, state.received);

  // eof: the world may have changed since chunk 0 — re-gate the final path
  // (the hardened policy catches `..`, ancestor symlinks, and any symlink
  // leaf planted mid-stream) before the rename can land bytes.
  if (!(await gate(rawPath))) {
    await discard(ctx, key);
    return { ok: false, error: `path refused: ${rawPath}` };
  }
  await mkdir(dirname(key), { recursive: true }); // parent may have been deleted mid-stream
  await rename(state.tmpPath, key); // POSIX rename: replaces an existing final, preserves the 0600 mode
  await enforceMode(key, 0o600); // landed bytes are user files — same re-tighten discipline as fs-mode.ts
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
