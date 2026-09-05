import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeAllowedDirs } from "@internal/subshell-protocol";
import { logger } from "./log.js";
import { pathAllowed } from "./path-policy.js";

/**
 * The node's own copy of its directory allowlist (spec 2026-09-05).
 *
 * The control plane owns the list — an owner edits it there — but the NODE
 * enforces it, against a copy it persists itself. That split is the entire
 * point of the feature: commands are signed, and a signature proves WHO sent
 * a launch, never WHETHER the directory is permitted. An allowlist carried
 * inside the `launch` command would be worth nothing against a compromised
 * control plane, which would simply send a permissive one. The same reasoning
 * already governs `path-policy.ts` for `write_file`/`remove_paths`.
 *
 * **Empty means unrestricted**, not "deny everything". A node that has never
 * been given rules behaves exactly as it did before this existed, and clearing
 * the rules returns it to that state. Fail-OPEN is correct here and fail-open
 * is usually wrong, so it is worth being explicit about why: this list is a
 * restriction an owner opts into, not an authentication decision. Treating a
 * missing or unreadable file as "deny all" would take a node offline for
 * every launch the first time a disk hiccup ate one byte of JSON.
 */

/** File name inside the agent data dir. */
const FILE = "allowed-dirs.json";

/** On-disk shape. Versioned so a future format change is detectable rather than silently misread. */
interface AllowedDirsFile {
  version: 1;
  dirs: string[];
}

/** Absolute path of the allowlist file for a data dir. */
export function allowedDirsPath(dataDir: string): string {
  return join(dataDir, FILE);
}

/**
 * Reads the persisted rules.
 *
 * Total: an absent, unreadable or corrupt file answers `[]` (unrestricted) and
 * logs. See the module note for why that direction is deliberate.
 */
export function readAllowedDirs(dataDir: string): string[] {
  const file = allowedDirsPath(dataDir);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new SyntaxError("not an object");
    const dirs = (parsed as Partial<AllowedDirsFile>).dirs;
    if (!Array.isArray(dirs)) throw new SyntaxError("missing dirs array");
    // Re-normalize on read: the file may have been hand-edited, and a rule
    // that is not normalized is a rule the prefix test cannot apply soundly.
    return normalizeAllowedDirs(dirs.filter((d): d is string => typeof d === "string"));
  } catch (err) {
    logger.withError(err).warn(`allowed-dirs: ${file} unreadable; treating this node as unrestricted`);
    return [];
  }
}

/**
 * Persists the rules, 0600, via temp + rename.
 *
 * Atomic because a launch can be checked at any moment: a half-written file
 * read mid-push would parse as corrupt and (per the fail-open rule above)
 * widen the node to unrestricted for exactly as long as the write took.
 *
 * @returns the normalized rules as stored
 */
export function writeAllowedDirs(dataDir: string, dirs: readonly string[]): string[] {
  const normalized = normalizeAllowedDirs(dirs);
  const file = allowedDirsPath(dataDir);
  const body: AllowedDirsFile = { version: 1, dirs: normalized };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return normalized;
}

/**
 * Whether a launch (or a probe of) `candidate` is permitted on this node.
 *
 * Delegates to {@link pathAllowed} — the filesystem-aware check that walks
 * symlinked ancestors, refuses `..` segments and denies symlink leaves. The
 * lexical `dirAllowed` in the protocol package is NOT enough here: this is the
 * decision that actually gates execution on this machine, and `resolve()`
 * collapse is symlink-blind (`/allowed/link/../../etc` collapses inside the
 * root while the kernel walks out of it).
 *
 * @param candidate - the directory a command wants to use
 * @param dirs - the persisted rules; empty = unrestricted, answers true
 */
export async function launchDirAllowed(candidate: string, dirs: readonly string[]): Promise<boolean> {
  if (dirs.length === 0) return true;
  return await pathAllowed(candidate, [...dirs]);
}

/** The refusal message, in one place so every executor says the same thing. */
export const DIR_REFUSED_MESSAGE = "directory is outside this node's allowed directories";
