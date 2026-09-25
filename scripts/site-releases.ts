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
 * The one extra hop: for the two DESKTOP components, write mode fetches each
 * release's own `release-manifest.json` + `.sig` from the release DOWNLOAD
 * host (which is not the API) and verifies the signature against the
 * committed publisher pubkey before trusting one byte of it — the same
 * signed-manifest rule every update path follows. What comes back is the
 * release's real asset list, so the site can offer a download only when the
 * release actually carries it (the Intel dmg's existence is a fact about the
 * newest cut, never a guess). Unverifiable → field omitted → site degrades
 * to the conservative view. `--check` never fetches: the field is stripped
 * from both sides before the drift comparison, because it is probe data the
 * check cannot re-derive deterministically.
 *
 * Modes:
 *   bun scripts/site-releases.ts           write releases.json from live tags
 *   bun scripts/site-releases.ts --check   exit 1 if the committed file drifts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyReleaseManifest } from "../packages/subshell-protocol/src/release-signature.js";
import type { ReleaseComponent } from "../packages/subshell-protocol/src/releases.js";
import {
  newestRelease,
  RELEASE_COMPONENTS,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  RELEASE_PUBKEY,
  SUBSHELL_REPO_SLUG,
} from "../packages/subshell-protocol/src/releases.js";

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
  /**
   * Desktop components only: the bundle file names the release verifiably
   * carries (`.dmg` / `.deb`), read from its signed `release-manifest.json`.
   * Additive-optional by decision — `schemaVersion` stays 1, because an old
   * reader strips an unknown field and a new reader on an old file simply
   * sees no field, so the generator and the site can deploy in either order.
   */
  desktopAssets?: string[];
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

/** Text-only fetch: a published JSON/sig file is UTF-8 by definition, and
 * `verifyReleaseManifest` re-encodes the text to bytes before verifying —
 * for well-formed UTF-8 that round trip is the exact published bytes. */
export type FetchText = (url: string) => Promise<string | null>;

/**
 * The asset names a release verifiably carries, or null for "you may not
 * state anything about this release's contents".
 *
 * Every failure mode answers null — missing manifest, missing signature,
 * foreign key, a payload naming a different release, a dead network. Null is
 * not a retry hint, it is the site behaving as if it had never asked.
 */
export async function verifiedReleaseAssets(
  component: ReleaseComponent,
  version: string,
  fetchText: FetchText,
  pubkey: string = RELEASE_PUBKEY,
): Promise<string[] | null> {
  const base = `https://github.com/${SUBSHELL_REPO_SLUG}/releases/download/${component}-v${version}`;
  try {
    const manifest = await fetchText(`${base}/${RELEASE_MANIFEST_NAME}`);
    if (manifest === null) return null;
    const sig = await fetchText(`${base}/${RELEASE_MANIFEST_SIG_NAME}`);
    if (sig === null) return null;
    const verified = await verifyReleaseManifest(manifest, sig, pubkey, { component, version });
    if (!verified.ok) return null;
    return Object.keys(verified.manifest.assets).sort();
  } catch {
    return null;
  }
}

/**
 * Of a release's asset names, the ones the site may put behind a download
 * button: the bundles themselves. Updater tarballs (`.app.tar.gz`), sigs and
 * digests stay invisible to the page — the button grammar knows DMGs and
 * debs by extension because those ARE the two bundle shapes this repo ships.
 */
export function desktopBundleNames(assetNames: readonly string[]): string[] {
  return assetNames.filter((n) => n.endsWith(".dmg") || n.endsWith(".deb"));
}

/** The live network default for {@link FetchText}: non-2xx, and any throw, is null. */
const fetchTextLive: FetchText = async (url) => {
  try {
    const res = await fetch(url, { headers: { accept: "*/*" } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
};

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
 *
 * `assetsFor` is the desktop probe (default: fetch the release's own manifest
 * and verify its signature). It runs only for the two desktop components, and
 * a null answer leaves `desktopAssets` ABSENT — the site's Intel button is
 * driven by a fact, never by hope.
 */
export async function writeReleases(
  runner: () => LsRemoteResult = defaultLsRemote,
  out: string = OUT,
  assetsFor: (component: ReleaseComponent, version: string) => Promise<string[] | null> = async (
    component,
    version,
  ) => desktopBundleNames((await verifiedReleaseAssets(component, version, fetchTextLive)) ?? []),
): Promise<number> {
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
  for (const component of ["desktop-server", "desktop-client"] as const) {
    const entry = manifest.components[component];
    if (entry === undefined) continue;
    const names = await assetsFor(component, entry.version);
    if (names !== null) entry.desktopAssets = names;
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
  // desktopAssets is probe data write mode gathered over the network; check
  // mode re-derives only the tag view, so the field is stripped from BOTH
  // sides. Its presence, absence, or content is never drift — a version or
  // tag that no longer matches still is.
  const norm = (m: SiteReleasesManifest) =>
    JSON.stringify({
      s: m.schemaVersion,
      c: Object.fromEntries(
        Object.entries(m.components).map(([k, v]) => [
          k,
          v === undefined ? v : Object.fromEntries(Object.entries(v).filter(([f]) => f !== "desktopAssets")),
        ]),
      ),
    });
  if (norm(fresh) !== norm(committed)) {
    console.error(`releases.json is stale.\n  committed: ${norm(committed)}\n  from tags: ${norm(fresh)}`);
    return 1;
  }
  console.log("releases.json matches the remote tags.");
  return 0;
}

if (import.meta.main) {
  process.exit(process.argv[2] === "--check" ? checkReleases() : await writeReleases());
}
