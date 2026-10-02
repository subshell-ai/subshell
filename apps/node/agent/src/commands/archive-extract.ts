import { extractTarGz } from "@internal/pane-runtime";
import type { JsonValue, NodeCommandBody } from "@internal/subshell-protocol";
import { DIR_REFUSED_MESSAGE, launchDirAllowed, readAllowedDirs } from "../allowed-dirs.js";
import { pathAllowed } from "../path-policy.js";
import { TRANSFER_ARCHIVE_LIMITS } from "./archive-create.js";
import type { CommandContext, CommandResult } from "./context.js";

/**
 * `archive_extract` (spec 2026-10-01 §3/§4): land a relayed tree. The
 * extraction guards ARE the security surface and they live in the format
 * module (`tar-extractor.ts`): traversal/absolute refusal after any pax
 * override, links and devices refused outright, per-file/total/entry caps
 * enforced DURING the pass. What this executor adds is the POLICY layer on
 * top of that: `destRoot` faces the operator allowlist, and `archivePath`
 * must be inside this node's dataDir — a transfer can only extract bytes the
 * relay itself landed, never some path a frame happened to name.
 *
 * The transport digest was verified by the CALLER (the plane compares the
 * relayed bytes against `archive_create`'s answer before it sends THIS
 * command); extraction therefore trusts only that the bytes are what the
 * source wrote. Whether they are benign is the guards' job, unchanged.
 *
 * ADDITIVE by ruling: matching paths are overwritten, everything else at the
 * destination is left alone, and nothing here deletes. The extractor throwing
 * (a refused entry, a cap, truncation) answers `ok:false` naming it — with
 * whatever files it had already landed in place; a re-run of the transfer is
 * the remedy, matching the additive contract.
 */

type Cmd = Extract<NodeCommandBody, { type: "archive_extract" }>;

/**
 * Extract the archive into `destRoot`.
 *
 * @param ctx - the per-daemon context (dataDir hosts staging, allowlist read fresh)
 * @param cmd - the verified `archive_extract` command body
 * @returns `{ files, bytes }` (NodeArchiveExtractResult) or a refusal
 */
export async function execArchiveExtract(ctx: CommandContext, cmd: Cmd): Promise<CommandResult> {
  if (!(await pathAllowed(cmd.archivePath, [ctx.config.dataDir]))) {
    return { ok: false, error: `archive path must be inside this node's data directory: ${cmd.archivePath}` };
  }
  if (!(await launchDirAllowed(cmd.destRoot, readAllowedDirs(ctx.config.dataDir)))) {
    return { ok: false, error: `${DIR_REFUSED_MESSAGE}: ${cmd.destRoot}` };
  }
  const r = await extractTarGz(cmd.archivePath, cmd.destRoot, TRANSFER_ARCHIVE_LIMITS);
  return { ok: true, data: r as unknown as JsonValue };
}
