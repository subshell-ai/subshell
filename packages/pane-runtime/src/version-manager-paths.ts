import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where version managers actually put things.
 *
 * `login-path.ts` exists because a service's PATH is baked at install time and
 * cannot see a harness installed through a node version manager. Measured on
 * 2026-09-09, it does not fix that case either, and the reason is worth
 * recording so nobody re-derives it: from a service-like environment neither
 * `sh -l` nor `bash -l` surfaces an nvm entry, because nvm initializes in
 * `~/.bashrc` and `~/.bashrc` returns early when the shell is not interactive.
 * A login shell is the wrong instrument for this particular question.
 *
 * `binary-lookup.ts` also says a static list cannot name these directories,
 * because nvm's carry a node VERSION. That is true of a static list and not of
 * a GLOB, which is what this module is. Globbing is deterministic, needs no
 * subprocess, cannot hang, and cannot run a user's profile, so it sits ABOVE
 * the login-shell rung rather than beside it.
 *
 * Probing an interactive shell (`bash -lic`) is the other way to reach the
 * same binaries and is deliberately not done: it runs the user's full
 * interactive startup, which prompts, prints and occasionally blocks.
 */

/** Glob patterns, relative to HOME, that expand to a directory holding binaries. */
const VERSIONED_BIN_GLOBS = [
  // nvm
  ".nvm/versions/node/*/bin",
  // fnm, both of its data-dir conventions
  ".local/share/fnm/node-versions/*/installation/bin",
  ".fnm/node-versions/*/installation/bin",
  // n
  "n/bin",
];

/**
 * Fixed directories, relative to HOME, that a manager keeps stable across
 * versions. Listed here rather than in each plugin's `knownPaths` because they
 * are properties of the MANAGER, not of any one harness.
 */
const STABLE_BINS = [
  ".volta/bin",
  ".asdf/shims",
  ".local/share/mise/shims",
  ".local/share/pnpm",
  ".bun/bin",
  ".yarn/bin",
];

/**
 * Compares two version-ish directory names, newest first.
 *
 * A version manager's "current" version is not knowable without running it, so
 * the newest installed one is the pick. It is a guess, but a stable and
 * explicable one, and it beats depending on readdir order.
 */
function byVersionDesc(a: string, b: string): number {
  const parse = (s: string) => (s.replace(/^v/, "").match(/\d+/g) ?? []).map(Number);
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (bv[i] ?? 0) - (av[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

/**
 * Directories a version manager may have put binaries in, newest version first.
 *
 * Total: an unreadable or absent HOME answers `[]`. Ordering is stable so a
 * lookup's answer does not move between calls on an unchanged machine.
 * @param home - HOME to resolve against (injectable for tests)
 */
export async function versionManagerBins(home: string = homedir()): Promise<string[]> {
  const dirs: string[] = [];

  for (const pattern of VERSIONED_BIN_GLOBS) {
    try {
      const matches: string[] = [];
      for await (const match of new Bun.Glob(pattern).scan({ cwd: home, onlyFiles: false })) {
        matches.push(match);
      }
      matches.sort(byVersionDesc);
      for (const match of matches) dirs.push(join(home, match));
    } catch {
      // A glob that cannot be scanned (no HOME, no permission) contributes
      // nothing. This is a best-effort rung, never a failure the caller acts on.
    }
  }

  for (const rel of STABLE_BINS) dirs.push(join(home, rel));

  return dirs;
}
