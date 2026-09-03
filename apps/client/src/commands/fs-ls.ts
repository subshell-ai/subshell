import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { FS_LS_MAX_ENTRIES, type JsonValue, type NodeFsLsResult } from "@internal/subshell-protocol";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `fs_ls` (node protocol v3, additive): one directory level for the control
 * plane's folder picker (`GET /api/files/explore?node=<id>`), answered so the
 * server can pass the payload through nearly unchanged. The semantics are the
 * LOCAL route's, mirrored deliberately:
 *
 * - empty `path` ⇒ the AGENT's home directory. The control plane cannot
 *   expand `~` against a filesystem it cannot see, so "home" means home ON
 *   THE NODE (that is what the user picked the node to launch on).
 * - otherwise ABSOLUTE ONLY and no `..` segment anywhere — the picker is a
 *   browser affordance aimed at one machine, not a path interpreter.
 *   (`~`, `~/x`, and friends die on the non-absolute arm here.)
 * - one level, dotfiles hidden, symlinked dirs listed through (stat follows,
 *   same as the local route's `statSync`).
 * - DIRECTORIES only. The local route also reports files with `kind: "file"`
 *   and the picker filters them client-side; a listing built for the folder
 *   picker ships only what that filter keeps. A target that exists but is
 *   not a directory answers the local route's file-path shape: empty
 *   `entries`, no error.
 * - ≤ {@link FS_LS_MAX_ENTRIES} entries with a `truncated` flag; the flag is
 *   wire-side future-proofing — the explore response has no truncation field.
 *
 * Confinement: NONE of the `SUBSHELL_FS_ROOT` kind — that root belongs to the
 * control-plane host and means nothing on another machine. This command is
 * deliberately OUTSIDE the {@link import("../path-policy.js").pathAllowed}
 * policy, exactly like `stat_dir` (probing a user-typed directory IS the
 * feature); the boundary is the agent user's filesystem permissions, the same
 * posture as every other node-side command. Missing / unreadable / refused
 * targets answer `ok:false` with an `ENOENT:`/`EACCES:`/`EINVAL:` prefix the
 * server maps to 404/403/400 (stat_dir's `ENOENT:`/`ENOTDIR:` style).
 */
export async function execFsLs(_ctx: CommandContext, cmd: Cmd<"fs_ls">): Promise<CommandResult> {
  const raw = cmd.path;
  if (raw !== "" && (!isAbsolute(raw) || raw.split(sep).includes(".."))) {
    return { ok: false, error: `EINVAL: ${raw}` };
  }
  const target = raw === "" ? homedir() : raw;

  let resolved: string;
  try {
    resolved = await realpath(target);
  } catch {
    return { ok: false, error: `ENOENT: ${target}` };
  }
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(resolved);
  } catch {
    return { ok: false, error: `ENOENT: ${target}` };
  }
  // Present but not a directory: the local route answers an empty listing
  // (a FILE path is browsable-looking with nothing in it) — mirror that
  // rather than invent a node-only error class.
  if (!st.isDirectory()) {
    // The interface cannot structurally satisfy JsonValue's index signature
    // (same seam as `probe`'s entries in basics.ts) — the shape is JSON-safe
    // by construction, `parseNodeFsLsResult` is the contract.
    return { ok: true, data: emptyListing(resolved) as unknown as JsonValue };
  }

  let names: string[];
  try {
    names = await readdir(resolved);
  } catch {
    return { ok: false, error: `EACCES: ${target}` };
  }

  const entries: NodeFsLsResult["entries"] = [];
  let truncated = false;
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(resolved, name);
    try {
      if (!(await stat(full)).isDirectory()) continue;
    } catch {
      continue; // raced death / unreadable child — the local route skips it too
    }
    if (entries.length >= FS_LS_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ name, path: full, kind: "dir" });
  }
  return { ok: true, data: { path: resolved, parent: parentOf(resolved), entries, truncated } };
}

/** The local route's parent rule: null only at the filesystem root. */
function parentOf(resolved: string): string | null {
  return resolved === "/" ? null : join(resolved, "..");
}

/** The local route's file-path answer: the directory fields, no children. */
function emptyListing(resolved: string): NodeFsLsResult {
  return { path: resolved, parent: parentOf(resolved), entries: [], truncated: false };
}
