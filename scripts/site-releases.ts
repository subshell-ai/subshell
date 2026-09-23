#!/usr/bin/env bun
/**
 * Generates the root `releases.json` — the file the marketing site reads to
 * know what the latest release of each component is (spec 2026-09-23 §3).
 *
 * Input is `git ls-remote --tags`, never the GitHub releases API: the tag IS
 * the release identity (release.yml's plan job pushes it first), and the
 * operator ruling for the website is that nothing in its supply chain calls
 * api.github.com. Version selection reuses the product's own `newestRelease`
 * (semver, never date) so the site can never disagree with an updater.
 *
 * Modes:
 *   bun scripts/site-releases.ts           write releases.json from live tags
 *   bun scripts/site-releases.ts --check   exit 1 if the committed file drifts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseComponent } from "../packages/subshell-protocol/src/releases.js";
import { newestRelease, RELEASE_COMPONENTS, SUBSHELL_REPO_SLUG } from "../packages/subshell-protocol/src/releases.js";

export const SCHEMA_VERSION = 1;
const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "releases.json");

/** Which component's install one-liner exists at the repo root. */
const KNOWN_SCRIPTS: Partial<Record<ReleaseComponent, string>> = {
  "cli-server": "install-server.sh",
  "desktop-client": "install-client.sh",
};

export interface SiteReleaseEntry {
  version: string;
  tag: string;
  url: string;
  installScript?: string;
}

export interface SiteReleasesManifest {
  schemaVersion: 1;
  generatedAt: string;
  components: Partial<Record<ReleaseComponent, SiteReleaseEntry>>;
}

export function parseLsRemote(output: string): string[] {
  const tags: string[] = [];
  for (const line of output.split("\n")) {
    const m = /^[0-9a-f]+\s+refs\/tags\/([^^{}]+)$/.exec(line.trim());
    if (m?.[1]) tags.push(m[1]);
  }
  return tags;
}

export function buildManifest(
  tags: readonly string[],
  opts: { generatedAt: string; installScripts: Partial<Record<ReleaseComponent, string>> },
): SiteReleasesManifest {
  const components: SiteReleasesManifest["components"] = {};
  for (const component of RELEASE_COMPONENTS) {
    const release = newestRelease(component, tags);
    if (release === null) continue;
    const entry: SiteReleaseEntry = {
      version: release.version,
      tag: release.tag,
      url: `https://github.com/${SUBSHELL_REPO_SLUG}/releases/tag/${release.tag}`,
    };
    const script = opts.installScripts[component];
    if (script !== undefined) entry.installScript = script;
    components[component] = entry;
  }
  return { schemaVersion: SCHEMA_VERSION, generatedAt: opts.generatedAt, components };
}

function liveInstallScripts(): Partial<Record<ReleaseComponent, string>> {
  const found: Partial<Record<ReleaseComponent, string>> = {};
  for (const [component, file] of Object.entries(KNOWN_SCRIPTS) as [ReleaseComponent, string][]) {
    if (existsSync(join(ROOT, file))) found[component] = file;
  }
  return found;
}

/** What a tag-listing run reports: git's exit code and raw stdout. */
export interface LsRemoteResult {
  exitCode: number;
  stdout: Uint8Array;
}

function defaultLsRemote(): LsRemoteResult {
  const proc = Bun.spawnSync({ cmd: ["git", "ls-remote", "--tags", "origin"], cwd: ROOT });
  return { exitCode: proc.exitCode, stdout: proc.stdout };
}

/**
 * The repository's tags, read from the remote.
 *
 * `runner` is the test seam for the git spawn. It THROWS on a non-zero exit
 * rather than returning `[]`: a failed `git ls-remote` (offline, origin
 * unreachable) leaves stdout empty, and empty stdout is indistinguishable
 * from a repo with no tags — proceeding would either overwrite the committed
 * `releases.json` with a zero-component manifest or report a false "stale".
 * Failing loudly here is what makes the write and check paths touch the file
 * only on a trustworthy tag list.
 */
export function lsRemoteTags(runner: () => LsRemoteResult = defaultLsRemote): string[] {
  const proc = runner();
  if (proc.exitCode !== 0) {
    throw new Error(`git ls-remote failed (exit ${proc.exitCode}); releases.json was NOT modified`);
  }
  return parseLsRemote(new TextDecoder().decode(proc.stdout));
}

/** The exit code a thrown runner error maps to (both modes report, never write). */
function runnerErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write mode: generate the manifest and write it to `out`. Returns the
 * process exit code; a failing `lsRemoteTags` aborts BEFORE any write.
 */
export function writeReleases(runner: () => LsRemoteResult = defaultLsRemote, out: string = OUT): number {
  let manifest: SiteReleasesManifest;
  try {
    manifest = buildManifest(lsRemoteTags(runner), {
      generatedAt: new Date().toISOString(),
      installScripts: liveInstallScripts(),
    });
  } catch (err) {
    console.error(runnerErrorMessage(err));
    return 1;
  }
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote releases.json (${Object.keys(manifest.components).length} components)`);
  return 0;
}

/**
 * Check mode: exit 1 if the committed file at `out` drifts from the live
 * tags. A failing `lsRemoteTags` is reported as failure, never as drift
 * against an empty tag list.
 */
export function checkReleases(runner: () => LsRemoteResult = defaultLsRemote, out: string = OUT): number {
  let fresh: SiteReleasesManifest;
  try {
    fresh = buildManifest(lsRemoteTags(runner), { generatedAt: "check", installScripts: liveInstallScripts() });
  } catch (err) {
    console.error(runnerErrorMessage(err));
    return 1;
  }
  if (!existsSync(out)) {
    console.error("releases.json is missing — run: bun scripts/site-releases.ts");
    return 1;
  }
  const committed = JSON.parse(readFileSync(out, "utf8")) as SiteReleasesManifest;
  const norm = (m: SiteReleasesManifest) => JSON.stringify({ s: m.schemaVersion, c: m.components });
  if (norm(fresh) !== norm(committed)) {
    console.error(`releases.json is stale.\n  committed: ${norm(committed)}\n  from tags: ${norm(fresh)}`);
    return 1;
  }
  console.log("releases.json matches the remote tags.");
  return 0;
}

if (import.meta.main) {
  process.exit(process.argv[2] === "--check" ? checkReleases() : writeReleases());
}
