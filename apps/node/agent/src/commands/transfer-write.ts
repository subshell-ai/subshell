import { MAX_TRANSFER_WINDOW_BYTES } from "@internal/subshell-protocol";
import { launchDirAllowed, readAllowedDirs } from "../allowed-dirs.js";
import { receiveChunkedStream } from "./chunked-stream.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `transfer_write` (spec 2026-10-01 §4): the relay's write half. The stream
 * discipline is `write_file`'s VERBATIM (temp-beside-final `.part`, in-order
 * chunks, gate-twice, rename-last — all of `chunked-stream.ts`); what makes
 * this its own command is the POLICY: the operator directory allowlist
 * (empty = unrestricted), not `write_file`'s dataDir-plus-tracked-cwds roots.
 * The two are pinned apart on purpose — merging them would either narrow
 * transfers to the upload roots or widen uploads past theirs, and the second
 * is weakening a load-bearing policy. The word-order difference in the names
 * is the tripwire; this header is the reason.
 *
 * A half transfer is one `.part` file, never half a tree: extraction only
 * ever runs against the renamed whole, and the plane's abort path names the
 * `.part` for `remove_paths` cleanup while the startup sweep catches the rest
 * in the directories it already knows.
 */

/**
 * Receive one chunk of a transfer stream.
 *
 * Refusals: an oversized decoded chunk (the window is a wire constant, and an
 * agent that accepted more had no way to answer inside the frame ceiling),
 * `path refused: …` on either allowlist check, and
 * `transfer_write chunk <N> has no open stream` on a sequencing miss (the
 * stream stays open for redelivery, as in `write_file`).
 *
 * @param ctx - the per-daemon context (`uploads` is shared with `write_file`:
 *   one stream per resolved path, whichever verb opened it)
 * @param cmd - the verified `transfer_write` command body
 * @returns `{ path, received }` on every accepted chunk (NodeWriteFileResult)
 */
export async function execTransferWrite(ctx: CommandContext, cmd: Cmd<"transfer_write">): Promise<CommandResult> {
  const bytes = Buffer.from(cmd.chunkB64, "base64");
  if (bytes.byteLength > MAX_TRANSFER_WINDOW_BYTES) {
    return {
      ok: false,
      error: `chunk of ${bytes.byteLength} bytes exceeds the ${MAX_TRANSFER_WINDOW_BYTES}-byte transfer window`,
    };
  }
  return await receiveChunkedStream(
    ctx,
    cmd.path,
    bytes,
    cmd.chunk,
    cmd.eof,
    "transfer_write",
    async (path) => await launchDirAllowed(path, readAllowedDirs(ctx.config.dataDir)),
  );
}
