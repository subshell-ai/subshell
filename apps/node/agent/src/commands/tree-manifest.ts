import { join } from "node:path";
import {
  type JsonValue,
  MAX_ARCHIVE_ENTRIES,
  MAX_MANIFEST_PAGE_ENTRIES,
  type NodeCommandBody,
} from "@internal/subshell-protocol";
import { DIR_REFUSED_MESSAGE, launchDirAllowed, readAllowedDirs } from "../allowed-dirs.js";
import { hashFileHex } from "./archive-create.js";
import type { CommandContext, CommandResult } from "./context.js";
import { walkTree } from "./tree-walk.js";

/**
 * `tree_manifest` (spec 2026-10-01 §2/§4): per-file facts for a whole tree,
 * paged, so the PLANE can diff two machines and name the changed set. The
 * diff key is SHA-256 of contents; `mtime` travels as a hint only, because
 * cross-machine clock skew is real and a diff that trusted it would churn.
 *
 * The page shape is frame-safe by construction: rows are capped by BOTH
 * {@link MAX_MANIFEST_PAGE_ENTRIES} and the caller's byte budget, and the
 * budget is spent on an ESTIMATE before a row is hashed (sha256 hex is 64
 * fixed chars, so the estimate is near-exact and never UNDER-spends enough to
 * matter). `nextCursor` is the last returned `relPath`, and the walk resumes
 * strictly after it - so paging needs no offset arithmetic that a
 * mid-sync mutation could invalidate, only string comparison.
 *
 * Trees that mutate between pages can dup or skip rows: sync is documented
 * eventual-convergent and re-running is the remedy (spec §4). A tree larger
 * than {@link MAX_ARCHIVE_ENTRIES} refuses outright rather than paging a
 * manifest of a tree no transfer could carry anyway.
 *
 * The cost, named honestly: the executor is STATELESS, so every page
 * re-walks the whole tree and string-compares its way past the cursor.
 * Paging an N-row tree is therefore N/pageRows walks - O(N²) lstats across a
 * full sync (a 100k-file tree pays ~200 walks per endpoint). v1 accepts
 * that: the per-root walk memo it would replace is a cache-invalidation
 * surface over a mutating tree, syncs are operator-rare where keystrokes
 * are agent-constant, and the caps keep every page inside its deadline.
 */

type Cmd = Extract<NodeCommandBody, { type: "tree_manifest" }>;

/**
 * Answer one manifest page for `cmd.root`.
 *
 * @param ctx - the per-daemon context (its dataDir hosts the allowlist file)
 * @param cmd - the verified `tree_manifest` command body
 * @returns `{ entries, nextCursor }` (NodeTreeManifestPage) or the allowlist
 *   refusal / the too-large refusal
 */
export async function execTreeManifest(ctx: CommandContext, cmd: Cmd): Promise<CommandResult> {
  if (!(await launchDirAllowed(cmd.root, readAllowedDirs(ctx.config.dataDir)))) {
    return { ok: false, error: `${DIR_REFUSED_MESSAGE}: ${cmd.root}` };
  }
  let walk;
  try {
    walk = await walkTree(cmd.root, MAX_ARCHIVE_ENTRIES);
  } catch (err) {
    return {
      ok: false,
      error: `tree_manifest could not read the tree: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const entries: { relPath: string; size: number; mtime: number; sha256: string }[] = [];
  let spent = 0;
  let done = true;
  for (const f of walk.files) {
    if (cmd.cursor !== undefined && f.relPath <= cmd.cursor) continue; // strictly after the cursor
    // Estimate before hashing: an escaped relPath plus the fixed row
    // furniture (keys, digits, the 64-char digest). Slight over-count is
    // correct here - a page that reads a touch SMALLER than its budget is
    // still a valid page; one that overshot the frame is not. The FIRST row
    // always enters, budget or not: a caller asking for less than one row
    // gets a page that overshoots its number rather than a cursor that
    // cannot advance (the protocol's relPath cap bounds the overshoot).
    const estimate = JSON.stringify(f.relPath).length + 110;
    if (entries.length >= MAX_MANIFEST_PAGE_ENTRIES || (entries.length > 0 && spent + estimate > cmd.maxBytes)) {
      done = false;
      break;
    }
    entries.push({
      relPath: f.relPath,
      size: f.size,
      mtime: f.mtimeSeconds,
      // The per-file digests are the diff itself; streamed, never a whole-file read.
      sha256: await hashFileHex(join(cmd.root, f.relPath)),
    });
    spent += estimate;
  }
  const page = { entries, nextCursor: done ? null : entries[entries.length - 1].relPath };
  return { ok: true, data: page as unknown as JsonValue };
}
