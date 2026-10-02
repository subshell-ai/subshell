import { extractTarGz } from "@internal/pane-runtime";
import type { JsonValue, NodeCommandBody } from "@internal/subshell-protocol";
import { DIR_REFUSED_MESSAGE, launchDirAllowed, readAllowedDirs } from "../allowed-dirs.js";
import { pathAllowed } from "../path-policy.js";
import { hashFileHex, TRANSFER_ARCHIVE_LIMITS } from "./archive-create.js";
import type { CommandContext, CommandResult } from "./context.js";
import { transfersDir } from "./staging-dir.js";

/**
 * `archive_extract` (spec 2026-10-01 §3/§4): land a relayed tree. The
 * extraction guards ARE the security surface and they live in the format
 * module (`tar-extractor.ts`): traversal/absolute refusal after any pax
 * override, links and devices refused outright, per-file/total/entry caps
 * enforced DURING the pass. What this executor adds is the POLICY layer on
 * top of that: `destRoot` faces the operator allowlist, and `archivePath`
 * must be inside this node's transfers staging subtree — a transfer can only
 * extract bytes the relay itself landed, never some path a frame named.
 *
 * The transport digest is verified TWICE, by design (spec §3): the plane
 * checked the relayed WINDOWS against `archive_create`'s answer, and this
 * executor re-hashes the LANDED file against the same digest before its
 * first entry lands. The second check is not redundancy: it is the only one
 * that can see a disk that corrupted, truncated, or swapped the file
 * between rename and extract - and it runs HERE because this is the disk
 * that stores the bytes the tree will be built from. A mismatch refuses
 * with `ok:false` and lands NOTHING.
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
  // The staging subtree twin (see `archive_create`): the bytes extracted
  // are always a relayed archive the plane minted under
  // `<dataDir>/transfers/`, so that - not the whole state dir - is the only
  // place a frame may name an archive from. Refusing elsewhere also stops a
  // frame pointing extraction at the node's OWN state files.
  if (!(await pathAllowed(cmd.archivePath, [transfersDir(ctx.config.dataDir)]))) {
    return {
      ok: false,
      error: `archive path must be inside the transfers staging directory under this node's data directory: ${cmd.archivePath}`,
    };
  }
  if (!(await launchDirAllowed(cmd.destRoot, readAllowedDirs(ctx.config.dataDir)))) {
    return { ok: false, error: `${DIR_REFUSED_MESSAGE}: ${cmd.destRoot}` };
  }
  // Re-hash the landed bytes before touching the destination tree (the
  // header says why this is a second, different check, not a repeat).
  const landed = await hashFileHex(cmd.archivePath).catch(() => null);
  if (landed === null) {
    return { ok: false, error: `archive vanished before extraction: ${cmd.archivePath}` };
  }
  if (landed !== cmd.expectedSha256) {
    return {
      ok: false,
      error: `archive digest mismatch: the landed file is not what the source wrote (nothing was extracted)`,
    };
  }
  const r = await extractTarGz(cmd.archivePath, cmd.destRoot, TRANSFER_ARCHIVE_LIMITS);
  return { ok: true, data: r as unknown as JsonValue };
}
