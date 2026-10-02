import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../log.js";
import type { CommandContext } from "./context.js";

/**
 * The staging sweep for the transfer surface (spec 2026-10-01 §4/§5, review
 * finding): a transfer that aborts WITHOUT a working plane - a link dropped
 * while the plane's `remove_paths` cleanup was in flight - leaves its
 * staging file (or its `.part`) under `<dataDir>/transfers/`, and nothing
 * else ever deletes it: the uploads sweep is shallow and `.part`-named, the
 * pane-log sweep is `.log`-only, and v1 keeps no transfer row to revisit.
 * Without this pass, every aborted transfer strands up to one archive until
 * the operator hand-deletes it.
 *
 * Posture copied from {@link cleanupStaleUploads}: boot + hourly, shallow
 * inside the ONE directory this verb owns, age-gated so a live stream is
 * never cut, `lstat` so a planted symlink is never chased, and NEVER throws
 * - a broken sweep must not cost the node its connection.
 */

/** Same one-hour grace as the uploads sweep: an in-flight stream stays young. */
const STALE_TRANSFER_MAX_AGE_MS = 60 * 60 * 1000;

/** The plane-minted staging name shape (`transfers.service.ts`'s `stagingPathFor`). */
function isStagingName(name: string): boolean {
  return name.endsWith(".tar.gz") || (name.startsWith(".") && name.endsWith(".tar.gz.part"));
}

/**
 * Delete aged staging files under `<dataDir>/transfers/` (both the renamed
 * whole and the `.part` temp; the destination's copy is the same shape in
 * ITS OWN transfers dir, swept by ITS OWN daemon). Missing or unreadable
 * directory, vanished files: skipped silently.
 *
 * @param ctx - the per-daemon context (dataDir and the clock read from here)
 */
export async function sweepStaleTransfers(ctx: CommandContext): Promise<void> {
  try {
    const dir = join(ctx.config.dataDir, "transfers");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return; // never transferred from this disk yet - nothing to sweep
    }
    const now = ctx.nowMs();
    for (const name of names) {
      if (!isStagingName(name)) continue; // only OUR naming, like the uploads sweep
      const path = join(dir, name);
      try {
        const st = await lstat(path);
        if (!st.isFile()) continue; // a stray dir is not ours to recurse into
        if (now - st.mtimeMs < STALE_TRANSFER_MAX_AGE_MS) continue;
        await unlink(path);
      } catch {
        // vanished mid-scan - best effort
      }
    }
  } catch (err) {
    log(`transfer staging sweep failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}
