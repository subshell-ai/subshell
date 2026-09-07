#!/usr/bin/env bun
/**
 * Keep `bun.lock`'s recorded workspace versions equal to each package.json.
 *
 * Bun records a `version` for every workspace in the lockfile and then never
 * resyncs it. Measured on bun 1.4.0, with a workspace bumped in its
 * package.json and the lockfile left stale: `bun install`, `bun install
 * --force`, `bun install --lockfile-only` and `bun install --lockfile-only
 * --force` ALL leave the old version in place, and `bun install
 * --frozen-lockfile` exits 0 rather than objecting. The only thing that fixes
 * it is deleting the lockfile and resolving from scratch — which on this repo
 * also bumps `lockfileVersion` and floats ~550 lines of transitive
 * dependencies, i.e. a dependency upgrade wearing a lockfile fix's clothes.
 *
 * So the drift is permanent and invisible. It arrived through the release
 * flow: the changesets Action runs `changeset version` and commits the bumps
 * itself, so lefthook's local "update bun lockfile" hook never fires, and the
 * lockfile trailed a whole release before anyone noticed.
 *
 * This is deliberately the NARROWEST possible edit — it rewrites the one
 * `version` field inside a workspace's own entry and touches nothing else. It
 * does not resolve, add, remove or reorder anything, which is what the
 * repo-wide "never hand-edit the lockfile, run bun install" rule is actually
 * about. Every replacement is anchored to its workspace path and asserted to
 * match exactly once; anything else aborts rather than guessing.
 *
 *   bun scripts/lockfile-workspace-versions.ts            # check (CI)
 *   bun scripts/lockfile-workspace-versions.ts --fix      # rewrite
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const LOCKFILE = join(REPO_ROOT, "bun.lock");

/** One workspace's recorded version, and what its package.json actually says. */
interface Entry {
  /** Workspace path as the lockfile keys it, e.g. `apps/server/api`. */
  path: string;
  /** The version recorded in `bun.lock`. */
  recorded: string;
  /** The version in that workspace's package.json. */
  actual: string;
}

/**
 * Every workspace entry whose recorded version disagrees with its package.json.
 *
 * The root workspace (key `""`) is skipped: it carries no `version` in the
 * lockfile.
 */
function drifted(lock: string): Entry[] {
  const out: Entry[] = [];
  const entry = /"([^"]+)":\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*"([^"]+)"/g;
  for (const match of lock.matchAll(entry)) {
    const [, path, recorded] = match;
    if (!path) continue;
    const manifest = join(REPO_ROOT, path, "package.json");
    const actual = String(JSON.parse(readFileSync(manifest, "utf8")).version ?? "");
    if (actual && actual !== recorded) out.push({ path, recorded, actual });
  }
  return out;
}

/** Rewrite each drifted entry's version, anchored to its own workspace path. */
function fix(lock: string, entries: Entry[]): string {
  let next = lock;
  for (const { path, recorded, actual } of entries) {
    const anchored = new RegExp(`("${path}":\\s*\\{\\s*"name":\\s*"[^"]+",\\s*"version":\\s*")${recorded}(")`);
    const matches = next.match(new RegExp(anchored, "g"));
    if (matches?.length !== 1) {
      throw new Error(`refusing to edit ${path}: expected exactly one anchored match, found ${matches?.length ?? 0}`);
    }
    next = next.replace(anchored, `$1${actual}$2`);
  }
  return next;
}

const lock = readFileSync(LOCKFILE, "utf8");
const entries = drifted(lock);

if (entries.length === 0) {
  console.log("bun.lock: every workspace version matches its package.json");
  process.exit(0);
}

for (const { path, recorded, actual } of entries) {
  console.error(`  ${path}: bun.lock says ${recorded}, package.json says ${actual}`);
}

if (!process.argv.includes("--fix")) {
  console.error(
    `\nbun.lock records ${entries.length} stale workspace version(s).\n` +
      "No `bun install` flag resyncs these — run `bun run lint:lockfile:fix`.",
  );
  process.exit(1);
}

writeFileSync(LOCKFILE, fix(lock, entries));
console.log(`\nbun.lock: resynced ${entries.length} workspace version(s)`);
