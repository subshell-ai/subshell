import { MAX_TRANSFER_WINDOW_BYTES } from "@internal/subshell-protocol";
import { readAllowedDirs } from "../allowed-dirs.js";
import { pathAllowed } from "../path-policy.js";
import { receiveChunkedStream } from "./chunked-stream.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { ensureTransfersDir } from "./staging-dir.js";

/**
 * `transfer_write` (spec 2026-10-01 §4): the relay's write half. The stream
 * discipline is `write_file`'s VERBATIM (temp-beside-final `.part`, in-order
 * chunks, gate-twice, rename-last — all of `chunked-stream.ts`); what makes
 * this its own command is the POLICY: the OPERATOR directory allowlist
 * unioned with the staging subtree `<dataDir>/transfers/` (empty list =
 * unrestricted, launch semantics). That subtree is in the permitted set
 * because the relayed archive lands there — the same twin `archive_create`
 * gates its staging on and `file_read` reads back from, so the rule-set
 * that never mentioned our state dir still carries the operator's files,
 * WITHOUT the over-wide option of a plane overwriting a node state file
 * through a transfer. NOT
 * `write_file`'s roots: transfers do not ride tracked subshell cwds, and
 * uploads do not reach the allowlist — the two policies are pinned apart on
 * purpose, merging either direction would widen a load-bearing surface. The
 * word-order difference in the names is the tripwire; this header is the
 * reason.
 *
 * A half transfer is one `.part` file, never half a tree: extraction only
 * ever runs against the renamed whole, and the plane's abort path names the
 * `.part` for `remove_paths` cleanup. When that cleanup cannot reach the
 * node (the link died mid-abort), `transfer-sweep.ts` - boot plus hourly -
 * ages the stragglers out of `<dataDir>/transfers/`, so an aborted transfer
 * strands bytes until the next beat, never until the next restart.
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
  // Destination first-writer: the gate below realpath's its roots, so the
  // staging dir must exist before the first chunk (a fresh node's transfers/
  // is created here, not demanded). A dataDir that cannot host it is a
  // refusal, never a silently-widened root.
  let stagingRoot: string;
  try {
    stagingRoot = ensureTransfersDir(ctx.config.dataDir);
  } catch (err) {
    return {
      ok: false,
      error: `cannot prepare the transfers staging directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return await receiveChunkedStream(ctx, cmd.path, bytes, cmd.chunk, cmd.eof, "transfer_write", async (path) => {
    const dirs = readAllowedDirs(ctx.config.dataDir);
    if (dirs.length === 0) return true; // unrestricted, verbatim launch semantics
    // The staging subtree, not all of dataDir: the relay only ever lands
    // plane-minted archives under `<dataDir>/transfers/`, and that is the
    // same twin `archive_create` and `file_read` gate on (an over-wide write
    // root here would be the one seam where a plane could overwrite a node
    // state file through a transfer). The hardened pathAllowed (not the
    // lexical one): `..`, symlinked ancestors and planted symlink leaves are
    // exactly what the eof re-check exists to catch.
    return await pathAllowed(path, [stagingRoot, ...dirs]);
  });
}
