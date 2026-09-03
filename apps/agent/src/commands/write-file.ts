import { appendFile, lstat, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { NodeCommandBody } from "@internal/subshell-protocol";
import { enforceMode } from "../fs-mode.js";
import { log } from "../log.js";
import { pathAllowed } from "../path-policy.js";
import type { CommandContext, CommandResult, UploadState } from "./context.js";

/**
 * The `write_file` chunk receiver (spec 2026-08-31 §3.4): the terminal-upload
 * relay delivers a file as ordered base64 chunks + an `eof` flag; the agent
 * accumulates each stream in a `.<basename>.part` temp BESIDE the final path
 * (same filesystem — the eof rename can never hit EXDEV) and moves it into
 * place on eof.
 *
 * The path policy gates TWICE per stream: on chunk 0 (before any parent
 * directory is created) and on eof (roots recomputed — a tracked cwd can
 * vanish, and the hardened policy catches ancestor symlinks planted after
 * the stream opened). Every accepted chunk answers the {@link NodeWriteFileResult}
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
 * `<dataDir>` + every tracked session's launch cwd (spec §7). Fresh by
 * construction, because both the cwd set and the symlinks beneath it drift
 * during a long-lived stream.
 */
async function policyRoots(ctx: CommandContext): Promise<string[]> {
  return [ctx.config.dataDir, ...(await ctx.meta.list()).map((m) => m.cwd)];
}

/** Best-effort: delete a stream's temp and drop its state (eof failure / sweep). */
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

/**
 * `write_file` (spec §3.4): receive one chunk of a chunked upload.
 *
 * Semantics (all refusal paths answer `ok:false` and change no stream state
 * except where noted):
 * - `chunk 0` always (re)starts a stream: policy-gate the raw path against
 *   {@link policyRoots}, `mkdir -p` the parent, (re)create the temp beside the
 *   final path with mode 0600. A chunk 0 over an OPEN stream deletes the old
 *   temp first — this is the mid-stream-failure self-heal the relay relies on.
 *   A refusal on chunk 0 writes NOTHING anywhere.
 * - `chunk N>0` requires an open stream whose `expectedChunk === N`, else
 *   `write_file chunk <N> has no open stream` (the stream itself stays open,
 *   so the control plane can redeliver the right index).
 * - `eof` RE-CHECKS the policy on fresh roots, `mkdir -p`s the parent again,
 *   renames temp→final (overwriting — timestamp-unique naming is the control
 *   plane's job), re-tightens the final to 0600, and drops the stream. An eof
 *   refusal deletes the temp and drops the stream — nothing stranded.
 *
 * @param ctx - the per-daemon context (`uploads` is this executor's map)
 * @param cmd - the verified `write_file` command body
 * @returns `{ path, received }` on every accepted chunk; the refusal strings above otherwise
 */
export async function execWriteFile(ctx: CommandContext, cmd: Cmd): Promise<CommandResult> {
  const key = resolve(cmd.path);
  const existing = ctx.uploads.get(key);
  const bytes = Buffer.from(cmd.chunk_b64, "base64");
  let state: UploadState;

  if (cmd.chunk === 0) {
    // Gate BEFORE any side effect: a refused path must create no dir, no temp.
    if (!(await pathAllowed(cmd.path, await policyRoots(ctx)))) {
      return { ok: false, error: `path refused: ${cmd.path}` };
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
    const tmpPath = join(dirname(key), `.${basename(key)}.part`);
    await writeFile(tmpPath, bytes, { mode: 0o600 });
    await enforceMode(tmpPath, 0o600); // umask can't loosen 0600, but a pre-existing temp might have
    state = { tmpPath, received: bytes.byteLength, expectedChunk: 1 };
    ctx.uploads.set(key, state);
  } else {
    if (!existing || cmd.chunk !== existing.expectedChunk) {
      return { ok: false, error: `write_file chunk ${cmd.chunk} has no open stream` };
    }
    await appendFile(existing.tmpPath, bytes);
    existing.received += bytes.byteLength;
    existing.expectedChunk += 1;
    state = existing;
  }

  if (!cmd.eof) return { ok: true, data: { path: cmd.path, received: state.received } };

  // eof: the world may have changed since chunk 0 — recompute roots and re-gate
  // the final path (the hardened policy catches `..`, ancestor symlinks, and
  // any symlink leaf planted mid-stream) before the rename can land bytes.
  if (!(await pathAllowed(cmd.path, await policyRoots(ctx)))) {
    await discard(ctx, key);
    return { ok: false, error: `path refused: ${cmd.path}` };
  }
  await mkdir(dirname(key), { recursive: true }); // parent may have been deleted mid-stream
  await rename(state.tmpPath, key); // POSIX rename: replaces an existing final, preserves the 0600 mode
  await enforceMode(key, 0o600); // uploads are user files — same re-tighten discipline as fs-mode.ts
  ctx.uploads.delete(key);
  return { ok: true, data: { path: cmd.path, received: state.received } };
}

/**
 * Sweep orphaned upload temps at daemon startup (spec §3.4): a crash between
 * chunk 0 and eof leaves a `.part` behind, so every boot deletes
 * `.*.part` REGULAR FILES older than {@link STALE_UPLOAD_MAX_AGE_MS} in
 * `<dataDir>` and each tracked session's cwd. The scan is deliberately
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
