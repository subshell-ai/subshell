#!/usr/bin/env bun
/**
 * Remove files from a node-artifacts directory that no current target can
 * produce.
 *
 * `publishArtifacts` writes and renames but never deletes — deliberately: it is
 * an atomic-swap publisher, not the directory's owner, and the directory is
 * scoped by `SUBSHELL_RELEASE_TRIPLES`, so a publisher that pruned would delete
 * every triple it had merely been told not to build. That is the wrong failure
 * to risk in the step that ships binaries.
 *
 * The consequence is leftovers. Renaming the published artifacts to
 * `subshell-cli-<triple>` orphaned every `subshell-<triple>`, and dropping the
 * Intel Mac target orphaned `subshell-cli-darwin-x64` — unreachable, since
 * nothing resolves to those names any more, but ~70 MB each.
 *
 * So pruning is its own explicit step, and it decides from the COMPLETE target
 * set rather than from a scope: a file survives if any current target could
 * publish it. Scope cannot enter here, which is exactly what makes it safe to
 * run after a partial publish.
 *
 *   bun scripts/prune-node-artifacts.ts <dir>           # list what it would remove
 *   bun scripts/prune-node-artifacts.ts <dir> --delete  # remove it
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { NODE_TARGETS, nodeArtifactFileName } from "../packages/subshell-protocol/src/paths.js";

const dir = process.argv[2];
if (!dir || dir.startsWith("--")) {
  console.error("usage: bun scripts/prune-node-artifacts.ts <node-artifacts-dir> [--delete]");
  process.exit(2);
}

/** Every file name a current target is allowed to publish, sidecars included. */
const keep = new Set(NODE_TARGETS.flatMap((t) => [nodeArtifactFileName(t), `${nodeArtifactFileName(t)}.sha256`]));

let entries: string[];
try {
  entries = readdirSync(dir);
} catch (err) {
  console.error(`cannot read ${dir}: ${(err as Error).message}`);
  process.exit(1);
}

// Directories are never ours — a data dir can hold neighbours — and a
// `.tmp-<pid>` file is a publish in flight, not an orphan.
const orphans = entries.filter(
  (name) => !keep.has(name) && !name.includes(".tmp-") && !statSync(join(dir, name)).isDirectory(),
);

if (orphans.length === 0) {
  console.log(`${dir}: nothing to prune — every file matches a current target`);
  process.exit(0);
}

let bytes = 0;
for (const name of orphans) {
  const size = statSync(join(dir, name)).size;
  bytes += size;
  console.log(`  ${name}  ${(size / 1_000_000).toFixed(1)} MB`);
}
const total = `${orphans.length} file(s), ${(bytes / 1_000_000).toFixed(1)} MB`;

if (!process.argv.includes("--delete")) {
  console.log(`\n${total} publishable by no current target. Re-run with --delete to remove them.`);
  process.exit(0);
}

for (const name of orphans) rmSync(join(dir, name), { force: true });
console.log(`\nremoved ${total}`);
