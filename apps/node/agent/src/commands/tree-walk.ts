import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The deterministic tree walk shared by `archive_create` and `tree_manifest`
 * (spec 2026-10-01 §4): one recursive, name-sorted pass that collects the
 * entries a transfer may carry, in a global relPath-sorted order. Both
 * commands MUST agree on what a tree contains and in what order it comes out,
 * or a sync's page cursors and the archive's layout would be two different
 * stories about the same directory.
 *
 * Skips, by construction: symlinks (any kind), devices and FIFOs. The
 * transfer format carries only regular files and directories and the
 * extractor refuses links outright, so a walked symlink is never "lost" by
 * this pass — it is a thing transfers do not carry, on both ends and on the
 * wire, and mid-sync its absence is stable (an eventual-convergent tree never
 * churns on it). Hidden names are NOT skipped (unlike the folder picker): a
 * transfer copies the tree, dotfiles included.
 */

/** One regular file, stat'd at walk time. */
export interface WalkedFile {
  /** Archive/manifest-relative path: posix, clean, sorted. */
  relPath: string;
  /** Absolute path on this machine, for the reader that follows. */
  absPath: string;
  /** Byte size at lstat time; the writer's drift check is the backstop. */
  size: number;
  /** Low 9 permission bits. */
  mode: number;
  /** mtime in whole seconds; the archive carries it, the manifest treats it as a hint. */
  mtimeSeconds: number;
}

/** One directory, stat'd at walk time (so empty dirs survive an archive). */
export interface WalkedDir {
  /** Relative path, NO trailing slash. */
  relPath: string;
  /** Low 9 permission bits. */
  mode: number;
  /** mtime in whole seconds. */
  mtimeSeconds: number;
}

/** A whole-tree walk: files and dirs each sorted by relPath. */
export interface TreeWalk {
  files: WalkedFile[];
  dirs: WalkedDir[];
}

/**
 * Walk `root` and collect at most `maxEntries` entries (files + dirs count;
 * throwing past it, because a caller that cannot carry the tree must refuse
 * loudly rather than answer a silently truncated archive or manifest).
 *
 * The entry list lives in memory for the whole walk — bounded by
 * `maxEntries`, which is {@link MAX_ARCHIVE_ENTRIES} at every real call site,
 * and the caps exist exactly so this is a bounded cost.
 *
 * @param root - the absolute directory to walk (callers gate its policy first)
 * @param maxEntries - hard cap on files + dirs, checked DURING the walk
 */
export async function walkTree(root: string, maxEntries: number): Promise<TreeWalk> {
  const files: WalkedFile[] = [];
  const dirs: WalkedDir[] = [];
  let seen = 0;

  async function step(absDir: string, relDir: string): Promise<void> {
    const names = (await readdir(absDir)).sort();
    for (const name of names) {
      const absPath = join(absDir, name);
      const relPath = relDir === "" ? name : `${relDir}/${name}`;
      const st = await lstat(absPath); // lstat, never stat: the symlink decision is about the ENTRY
      if (st.isSymbolicLink()) continue;
      if (!st.isFile() && !st.isDirectory()) continue;
      if (++seen > maxEntries) throw new Error(`tree: more than ${maxEntries} entries under ${root}`);
      if (st.isDirectory()) {
        dirs.push({ relPath, mode: st.mode & 0o777, mtimeSeconds: Math.floor(st.mtimeMs / 1000) });
        await step(absPath, relPath);
        continue;
      }
      files.push({
        relPath,
        absPath,
        size: st.size,
        mode: st.mode & 0o777,
        mtimeSeconds: Math.floor(st.mtimeMs / 1000),
      });
    }
  }

  await step(root, "");
  // Per-directory sorting gives a DFS order that is NOT global relPath order
  // (`a.txt` vs `a/`-dir children interleave by separator bytes); the
  // cursor and diff contracts want plain string order, so sort the flat lists.
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  dirs.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files, dirs };
}
