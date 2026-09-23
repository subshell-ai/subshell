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

function lsRemoteTags(): string[] {
  const proc = Bun.spawnSync({ cmd: ["git", "ls-remote", "--tags", "origin"], cwd: ROOT });
  return parseLsRemote(new TextDecoder().decode(proc.stdout));
}

function check(): number {
  const tags = lsRemoteTags();
  const fresh = buildManifest(tags, { generatedAt: "check", installScripts: liveInstallScripts() });
  if (!existsSync(OUT)) {
    console.error("releases.json is missing — run: bun scripts/site-releases.ts");
    return 1;
  }
  const committed = JSON.parse(readFileSync(OUT, "utf8")) as SiteReleasesManifest;
  const norm = (m: SiteReleasesManifest) => JSON.stringify({ s: m.schemaVersion, c: m.components });
  if (norm(fresh) !== norm(committed)) {
    console.error(`releases.json is stale.\n  committed: ${norm(committed)}\n  from tags: ${norm(fresh)}`);
    return 1;
  }
  console.log("releases.json matches the remote tags.");
  return 0;
}

if (import.meta.main) {
  if (process.argv[2] === "--check") process.exit(check());
  const manifest = buildManifest(lsRemoteTags(), {
    generatedAt: new Date().toISOString(),
    installScripts: liveInstallScripts(),
  });
  writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote releases.json (${Object.keys(manifest.components).length} components)`);
}
