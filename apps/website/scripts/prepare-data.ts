#!/usr/bin/env bun
/**
 * Two build-time copies from the repo root, run before every build and dev
 * start:
 *
 * - `releases.json` into `data/` — same file, one hop: the baked copy is what
 *   the page ships, and the runtime fetch refreshes it (spec 2026-09-23 §4).
 *   A missing root file is a hard error at build time: an empty install
 *   section would ship silently otherwise.
 * - `install-server.sh` / `install-client.sh` into `public/` — this is what
 *   makes the one-liners `curl -fsSL https://subshell.sh/install-<x>.sh | bash`
 *   true: the site serves its OWN copies of the root scripts (Next ships
 *   `public/` verbatim in the static export), so visitors never fetch from
 *   the git host. The repo root stays the single source; these copies are
 *   gitignored build inputs. An edited root script therefore means REDEPLOYING
 *   the site before the one-liner is trustworthy — the discipline is stated in
 *   `docs/release-and-ci.md`, and the post-cut tripwire is the byte-compare
 *   step in `scripts/cli-e2e/published-release.sh`.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const src = join(root, "releases.json");
const dir = join(root, "apps", "website", "data");
mkdirSync(dir, { recursive: true });
copyFileSync(src, join(dir, "releases.json"));
console.log("data/releases.json refreshed from the repo root");

const publicDir = join(root, "apps", "website", "public");
mkdirSync(publicDir, { recursive: true });
for (const script of ["install-server.sh", "install-client.sh"]) {
  copyFileSync(join(root, script), join(publicDir, script));
  console.log(`public/${script} refreshed from the repo root`);
}
