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
 * inside the ONE directory this verb owns, age-gated, `lstat` so a planted
 * symlink is never chased, and NEVER throws - a broken sweep must not cost
 * the node its connection.
 */

/**
 * Age past which a stranded staging file is swept - and why it is NOT the
 * uploads sweep's one hour. This is a real tradeoff, not a free win: the
 * DESTINATION's `.part` refreshes its mtime on every append, so a short
 * grace is safe there, but the SOURCE staging file's mtime FREEZES when
 * `archive_create` closes it and the relay then reads it STATELESSLY
 * (`file_read` touches nothing, on purpose: touching would corrupt the
 * `mtime` hint `tree_manifest` diffs on). So mtime is the sweeper's only
 * liveness signal for the source half, and it cannot see a read in
 * progress.
 *
 * A 4 GiB archive is `MAX_ARCHIVE_BYTES / MAX_TRANSFER_WINDOW_BYTES` = 8192
 * windows. At the design sizing's ~5 MiB/s that relays in ~13 min; the
 * theoretical timeout-sum ceiling (8192 x (READ 10s + WRITE 30s) ~ 91 h)
 * describes a WEDGED transfer, not a slow one, and no grace short of
 * effectively leaking the disk should chase it. Four hours clears the design
 * envelope with ~18x margin (covering a slow satellite/VPN link the spec's
 * RTT sizing concedes) while capping a genuinely stranded archive's plaintext
 * disk hold to a workday. v1 keeps no transfer row, so a relay slower than
 * THIS bound is indistinguishable from a dead one and may be swept mid-flight
 * - the honest limit of an age-only signal.
 */
const STALE_TRANSFER_MAX_AGE_MS = 4 * 60 * 60 * 1000;

/**
 * The plane-minted staging name shape (`transfers.service.ts`'s
 * `stagingPathFor`): `<uuid>.tar.gz` once renamed whole, and its temp is the
 * basename of the shared `partPathOf` the writer and the plane's abort
 * cleanup both use (`. + that name + .part`). This is the matcher view of
 * that one contract, and it is deliberately permissive: over-matching a stray
 * `.tar.gz` only means the age gate checks it too, while under-matching a
 * real temp is what strands plaintext on disk. The builder in
 * `@internal/subshell-protocol` is the source of truth for the temp's spelling.
 */
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
