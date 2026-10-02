import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, realpath, stat, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import {
  type ArchiveDir,
  type ArchiveFile,
  type ArchiveLimits,
  safeTransferPath,
  writeTarGz,
} from "@internal/pane-runtime";
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_FILE_BYTES,
  type NodeCommandBody,
} from "@internal/subshell-protocol";
import { DIR_REFUSED_MESSAGE, launchDirAllowed, readAllowedDirs } from "../allowed-dirs.js";
import { pathAllowed } from "../path-policy.js";
import type { CommandContext, CommandResult } from "./context.js";
import { type WalkedDir, type WalkedFile, walkTree } from "./tree-walk.js";

/**
 * `archive_create` (spec 2026-10-01 §2/§4): build the transfer's source
 * archive ON this machine and answer its transport facts, so the plane never
 * touches file contents to move a tree — it relays one opaque gzip file and
 * the destination re-verifies the digest named HERE.
 *
 * The two gates are two different policies, and the split is the whole point:
 * `root` faces the OPERATOR allowlist (empty = unrestricted, launch semantics
 * verbatim), while `stagingPath` must live inside this node's own dataDir —
 * that is what makes the existing `remove_paths` root set the cleanup path
 * for staging, and a plane-minted name outside our state dir is refused
 * regardless of how generous the allowlist is. The name's UNIQUENESS is the
 * plane's job (spec §4: a timed-out retry must not double-write the first
 * attempt's file); its sanity is ours.
 *
 * The walk, the writer and the digest are each streaming or capped: the walk
 * refuses a tree past `MAX_ARCHIVE_ENTRIES` before it can exhaust memory,
 * `writeTarGz` enforces per-file/total caps AS bytes flow (never buffering
 * the tree — the compiled-binary probe pinned node:zlib streaming, spec §1),
 * and the sha256 runs over the COMPRESSED staging file in a second streaming
 * pass, because that is the exact span the destination reassembles.
 */

type CmdBody = Extract<NodeCommandBody, { type: "archive_create" }>;

/** The shared transfer caps (protocol constants; the extractor runs the same). */
export const TRANSFER_ARCHIVE_LIMITS: ArchiveLimits = {
  maxFileBytes: MAX_ARCHIVE_FILE_BYTES,
  maxTotalBytes: MAX_ARCHIVE_BYTES,
  maxEntries: MAX_ARCHIVE_ENTRIES,
};

/**
 * Create the archive. Failure modes answer `ok:false` and leave no staging
 * file behind: a refused root or staging path writes NOTHING; a walk or write
 * that throws mid-archive unlinks the partial file before the refusal rides
 * back (the plane's `remove_paths` stays the backstop, not the plan).
 *
 * @param ctx - the per-daemon context (dataDir owns staging, allowlist is read fresh)
 * @param cmd - the verified `archive_create` command body
 * @returns `{ size, sha256 }` over the compressed staging file (NodeArchiveCreateResult)
 */
export async function execArchiveCreate(ctx: CommandContext, cmd: CmdBody): Promise<CommandResult> {
  const dirs = readAllowedDirs(ctx.config.dataDir);
  if (!(await launchDirAllowed(cmd.root, dirs))) {
    return { ok: false, error: `${DIR_REFUSED_MESSAGE}: ${cmd.root}` };
  }
  if (
    !(await pathAllowed(cmd.stagingPath, [ctx.config.dataDir])) // also refuses `..` and symlink leaves
  ) {
    return { ok: false, error: `staging path must be inside this node's data directory: ${cmd.stagingPath}` };
  }

  let files: WalkedFile[];
  let dirsOut: WalkedDir[];
  try {
    if (cmd.files === undefined) {
      const walk = await walkTree(cmd.root, MAX_ARCHIVE_ENTRIES);
      files = walk.files;
      dirsOut = walk.dirs;
    } else {
      const sel = await selectFiles(cmd.root, cmd.files);
      if ("error" in sel) return { ok: false, error: sel.error };
      files = sel.files;
      dirsOut = sel.dirs;
    }
  } catch (err) {
    return {
      ok: false,
      error: `archive_create could not read the tree: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await mkdir(dirname(cmd.stagingPath), { recursive: true });
  try {
    const sink = createWriteStream(cmd.stagingPath);
    await writeTarGz(
      dirsOut.map((d): ArchiveDir => ({ path: d.relPath, mode: d.mode, mtimeSeconds: d.mtimeSeconds })),
      files.map(
        (f): ArchiveFile => ({
          path: f.relPath,
          sourcePath: f.absPath,
          size: f.size,
          mode: f.mode,
          mtimeSeconds: f.mtimeSeconds,
        }),
      ),
      sink,
      TRANSFER_ARCHIVE_LIMITS,
    );
  } catch (err) {
    await unlink(cmd.stagingPath).catch(() => {}); // partial file must not outlive the refusal
    return { ok: false, error: `archive_create failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const size = (await stat(cmd.stagingPath)).size;
  const sha256 = await hashFileHex(cmd.stagingPath);
  // The seam cast: the result shape is JSON-safe by construction and
  // `node-results.ts` owns its contract (same route as every other executor).
  return { ok: true, data: { size, sha256 } };
}

/**
 * Resolve an explicit `files[]` list against `root`: every entry is the
 * transfer path guard's to pass, must lstat to a REGULAR file under the root,
 * and its realpath must stay under the root's realpath — so a symlinked
 * ancestor directory inside the root cannot smuggle a read from outside it.
 * Ancestor directories are collected (deduped, sorted) so the extracted tree
 * reproduces the shape. A refused entry refuses the whole command: an
 * explicit list that partially applied would answer success about a tree that
 * is not the one named.
 */
async function selectFiles(
  root: string,
  list: string[],
): Promise<{ files: WalkedFile[]; dirs: WalkedDir[] } | { error: string }> {
  const rootReal = await realpath(root);
  const byRel = new Map<string, WalkedFile>();
  const dirByRel = new Map<string, WalkedDir>();
  for (const entry of list) {
    let rel: string;
    try {
      rel = safeTransferPath(entry);
    } catch {
      return { error: `archive_create files entry is not a clean transfer path: ${entry}` };
    }
    const absPath = join(root, rel);
    const absReal = await realpath(absPath).catch(() => null);
    if (absReal === null) return { error: `archive_create files entry does not exist under the root: ${entry}` };
    if (!(absReal === rootReal || absReal.startsWith(rootReal + sep))) {
      return { error: `archive_create files entry resolves outside the root: ${entry}` };
    }
    const st = await stat(absReal);
    if (!st.isFile()) return { error: `archive_create files entry is not a regular file: ${entry}` };
    if (!byRel.has(rel)) {
      byRel.set(rel, {
        relPath: rel,
        absPath: absReal,
        size: st.size,
        mode: st.mode & 0o777,
        mtimeSeconds: Math.floor(st.mtimeMs / 1000),
      });
    }
    // Ancestors of the selected file, so the extracted shape matches.
    let rest = rel;
    for (;;) {
      const cut = rest.lastIndexOf("/");
      if (cut <= 0) break;
      rest = rest.slice(0, cut);
      if (dirByRel.has(rest)) continue;
      try {
        const dst = await stat(join(root, rest));
        dirByRel.set(rest, { relPath: rest, mode: dst.mode & 0o777, mtimeSeconds: Math.floor(dst.mtimeMs / 1000) });
      } catch {
        break; // impossible: the file exists, so its parents do
      }
    }
  }
  const files = [...byRel.values()].sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  const dirs = [...dirByRel.values()].sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return { files, dirs };
}

/**
 * Streaming sha256 of a file on this disk (`update.ts`'s hasher, pointed at
 * our own bytes). Exported for `tree_manifest`, which hashes whole trees with
 * the same flat-memory loop.
 */
export async function hashFileHex(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256"); // the measured flat-RSS primitive, same loop as the update download
  for await (const chunk of createReadStream(path)) hasher.update(chunk as Uint8Array);
  return hasher.digest("hex");
}
