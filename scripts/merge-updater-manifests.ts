#!/usr/bin/env bun
/**
 * Merge the build shards' `latest.<triple>.json` files into the one
 * `latest.json` the desktop updater reads (spec 2026-09-15 § 8).
 *
 * ```
 * bun scripts/merge-updater-manifests.ts <dir> [--out <dir>]
 * ```
 *
 * Run by `release.yml`'s publish job, over the directory the shards' artifacts
 * were downloaded into, BEFORE the draft upload — that is the first moment all
 * the platforms exist in one place, and `latest.json` has to be among the
 * assets the draft carries or the plugin has nothing to point at.
 *
 * `<dir>` is searched one level deep as well as at the top, because
 * `download-artifact` lands each shard in its own subdirectory
 * (`dist/desktop-server-darwin-arm64/…`). The merged file is written to
 * `--out` (default `<dir>`), which is ABOVE the per-shard directories the
 * publish job's asset glob reaches — so the workflow lists `latest.json`
 * explicitly rather than relying on that glob to find it.
 *
 * Exits non-zero on anything that would publish a manifest nobody can use: no
 * shards found, shards that disagree on the version, a platform claimed twice,
 * or an entry with no signature. All four are release-stopping by design — an
 * unusable manifest is indistinguishable, from an installed app, from "there
 * are no updates".
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  LATEST_MANIFEST_NAME,
  mergeUpdaterManifests,
  parseShardManifest,
  type UpdaterManifest,
} from "./updater-manifest.js";

/**
 * Every `latest.<triple>.json` under `dir`, at the top level or one directory
 * down. Sorted, so a merge is reproducible and a failure names a stable file.
 */
export function findShardManifests(dir: string): string[] {
  const found: string[] = [];
  const scan = (at: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(at);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) {
        if (depth > 0) scan(path, depth - 1);
        continue;
      }
      // `latest.json` itself is excluded: re-merging a previous run's output
      // would claim every platform twice and refuse, which is a confusing way
      // to discover that the directory was reused.
      if (name.startsWith("latest.") && name.endsWith(".json") && name !== LATEST_MANIFEST_NAME) {
        found.push(path);
      }
    }
  };
  scan(dir, 1);
  return found;
}

/** Read and merge, naming the file in any refusal. */
export function mergeFrom(paths: readonly string[]): UpdaterManifest {
  const shards = paths.map((path) => parseShardManifest(readFileSync(path, "utf8"), basename(path)));
  return mergeUpdaterManifests(shards);
}

function main(argv: readonly string[]): void {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const dir = positional[0];
  if (dir === undefined) {
    console.error("usage: bun scripts/merge-updater-manifests.ts <dir> [--out <dir>]");
    process.exit(1);
  }
  const outIndex = argv.indexOf("--out");
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const from = resolve(dir);
  if (!existsSync(from)) throw new Error(`${from} does not exist`);

  const paths = findShardManifests(from);
  if (paths.length === 0) throw new Error(`no latest.<triple>.json under ${from}`);
  const merged = mergeFrom(paths);

  const destDir = resolve(out ?? from);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, LATEST_MANIFEST_NAME);
  writeFileSync(dest, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`merged ${paths.length} shard manifest(s) → ${dest}`);
  for (const key of Object.keys(merged.platforms)) console.log(`  ${key}`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
