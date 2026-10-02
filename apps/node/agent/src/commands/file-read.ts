import type { JsonValue, NodeCommandBody, NodeFileReadResult } from "@internal/subshell-protocol";
import { DIR_REFUSED_MESSAGE, readAllowedDirs } from "../allowed-dirs.js";
import { pathAllowed } from "../path-policy.js";
import type { CommandContext, CommandResult } from "./context.js";
import { transfersDir } from "./staging-dir.js";

/**
 * `file_read` (spec 2026-10-01 §2): answer one byte window of an arbitrary
 * file, the relay's read half. This is the GENERALIZED `log_read`, and the
 * two stay deliberately unshared — `log_read` is confined to
 * `<dataDir>/subshells/<id>.log` (pane logs hold what operators typed),
 * while this one reads what the OPERATOR ALLOWLIST permits for transfers.
 * One name for both would be one step from one code path for both, which is
 * exactly the mistake the naming rule in `write_file`/`transfer_write`
 * exists to prevent.
 *
 * The window mechanics are `execLogRead`'s, including its kindnesses: a
 * missing file reads as size 0, and a cursor at or past EOF answers empty
 * with `next` clamped to the size, so the relay's loop terminates cleanly
 * instead of erroring on the last window's race.
 */

type Cmd = Extract<NodeCommandBody, { type: "file_read" }>;

/**
 * Read `[fromByte, fromByte + maxBytes)` of `cmd.path`.
 *
 * @param ctx - the per-daemon context (its dataDir hosts the allowlist file)
 * @param cmd - the verified `file_read` command body (`maxBytes` is
 *   window-capped by the frame parser before this runs)
 * @returns `{ bytes_b64, next, size }` (NodeFileReadResult), or the allowlist
 *   refusal
 */
export async function execFileRead(ctx: CommandContext, cmd: Cmd): Promise<CommandResult> {
  const dirs = readAllowedDirs(ctx.config.dataDir);
  // The staging subtree joins the permitted roots, or the relay strands
  // itself on every node with a configured list: the plane reads ONLY the
  // `archive_create` staging file it minted under `<dataDir>/transfers/`,
  // and WORKING directories are what the allowlist names. The union is
  // narrow on purpose (mirror of `transfer_write`'s, which admits dataDir
  // wholesale): UNIONING ALL OF dataDir HERE would let one plane-issued
  // read pull `node-signing.json` or `<dataDir>/subshells/*.log` - pane
  // logs hold what operators typed, and `log_read` stays their only
  // reader. With an empty list the whole disk is readable by ruling, so
  // the subtree adds nothing and the check is skipped; with a list, the
  // hardened `pathAllowed` (not the lexical check) also denies planted
  // symlinks inside the staging dir, as everywhere else on this seam.
  if (dirs.length > 0 && !(await pathAllowed(cmd.path, [transfersDir(ctx.config.dataDir), ...dirs]))) {
    return { ok: false, error: `${DIR_REFUSED_MESSAGE}: ${cmd.path}` };
  }
  const file = Bun.file(cmd.path);
  const empty = (size: number): CommandResult => {
    const data: NodeFileReadResult = { bytes_b64: "", next: Math.min(cmd.fromByte, size), size };
    return { ok: true, data: data as unknown as JsonValue };
  };
  const size = file.size; // Bun yields 0 for a missing file — the empty-read path covers it
  if (size === 0 || cmd.fromByte >= size) return empty(size);
  const end = Math.min(size, cmd.fromByte + cmd.maxBytes);
  try {
    const bytes = await file.slice(cmd.fromByte, end).bytes();
    const data: NodeFileReadResult = {
      bytes_b64: Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
      next: cmd.fromByte + bytes.byteLength,
      size,
    };
    return { ok: true, data: data as unknown as JsonValue };
  } catch {
    return empty(size); // raced unlink between stat and slice — reads as empty, as the log twin does
  }
}
