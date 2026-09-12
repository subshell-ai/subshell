#!/usr/bin/env bun
/**
 * Give every published `@subshell-ai/*` version a GitHub Release.
 *
 * `changeset publish` publishes to npm and pushes a `<name>@<version>` tag for
 * each package, and there it stopped: the Releases page showed the four app
 * cuts and nothing else, so the seven packages had tags with no notes against
 * them and the prose changesets had already written — each package's own
 * CHANGELOG entry — never travelled anywhere a reader would find it. This is
 * the same gap the app releases had before their `body_path` step, fixed the
 * same way and from the same source.
 *
 * Two properties make it safe to run on every publish:
 *
 * - **It is self-healing rather than incremental.** It asks GitHub which of
 *   the current versions already have a release and creates the rest, so a
 *   half-finished run converges on the next one and versions published before
 *   this script existed get their release the first time it runs. Nothing is
 *   parsed out of `changeset publish`'s stdout, which would tie this to that
 *   command's output format and answer nothing about the backlog.
 * - **It never claims to be the latest release.** `--latest=false` on every
 *   one, because the Releases page's "Latest" badge belongs to a thing a
 *   person downloads — a server or a desktop build — and a plugin patch would
 *   otherwise take it, which is the failure that makes a releases page
 *   actively misleading rather than merely sparse.
 *
 *   bun scripts/package-releases.ts --dry-run   # print what it would create
 *   bun scripts/package-releases.ts             # create the missing releases
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

/**
 * Where publishable packages live. The same globs `license-fields.ts` walks,
 * minus the app and crate manifests: only `packages/**` is ever published to
 * npm, and an app appearing here would mean the release model had changed.
 */
const MANIFEST_GLOBS = ["packages/*/package.json", "packages/plugins/*/package.json"];

/** One package's identity, as the release needs it. */
export interface PublishedPackage {
  name: string;
  version: string;
  /** `<name>@<version>` — the tag `changeset publish` pushes. */
  tag: string;
  /** Repo-relative directory, for its CHANGELOG. */
  dir: string;
}

/** Every non-private package under `packages/`, with the tag its version implies. */
export function publishedPackages(root = REPO_ROOT): PublishedPackage[] {
  const found: PublishedPackage[] = [];
  for (const pattern of MANIFEST_GLOBS) {
    for (const match of new Glob(pattern).scanSync({ cwd: root, absolute: false })) {
      const path = match.replaceAll("\\", "/");
      const manifest = JSON.parse(readFileSync(resolve(root, path), "utf8")) as {
        name?: string;
        version?: string;
        private?: boolean;
      };
      if (manifest.private === true || !manifest.name || !manifest.version) continue;
      found.push({
        name: manifest.name,
        version: manifest.version,
        tag: `${manifest.name}@${manifest.version}`,
        dir: path.slice(0, path.lastIndexOf("/")),
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The body for one version, sliced out of a CHANGELOG.
 *
 * Anchored on the `## <version>` heading changesets emits and stopping at the
 * next one — the same rule `release.yml` applies to `apps/<dir>/CHANGELOG.md`,
 * restated here rather than shared because that one is five lines of awk
 * inside a workflow step and reaching into it would couple the app cut, which
 * is the more delicate path, to this one.
 *
 * Returns null when there is no such section. A version bumped with no
 * changeset is legitimate, and a release with a thin body beats no release.
 */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## ") && line.slice(3).trim() === version);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body === "" ? null : body;
}

/** What a release says when its version left no changelog entry behind. */
export function placeholderBody(pkg: PublishedPackage): string {
  return `\`${pkg.name}\` ${pkg.version}. See the commit history for changes.`;
}

/** The body to publish for a package: its changelog section, or the placeholder. */
export function releaseBody(pkg: PublishedPackage, root = REPO_ROOT): string {
  let changelog: string;
  try {
    changelog = readFileSync(resolve(root, `${pkg.dir}/CHANGELOG.md`), "utf8");
  } catch {
    return placeholderBody(pkg);
  }
  return changelogSection(changelog, pkg.version) ?? placeholderBody(pkg);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** Whether a release already exists for a tag. A `gh` failure means "no". */
async function releaseExists(tag: string): Promise<boolean> {
  const probe = Bun.spawn(["gh", "release", "view", tag, "--json", "tagName"], {
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await probe.exited) === 0;
}

/** Whether the tag exists at all. Releasing a tag git does not have would create one. */
async function tagExists(tag: string): Promise<boolean> {
  const probe = Bun.spawn(["git", "rev-parse", "--verify", `refs/tags/${tag}`], {
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await probe.exited) === 0;
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  const packages = publishedPackages();
  if (packages.length === 0) throw new Error("no publishable packages found — the globs are wrong");

  let created = 0;
  let skipped = 0;
  for (const pkg of packages) {
    if (!(await tagExists(pkg.tag))) {
      // `changeset publish` pushes the tag; without one there is nothing to
      // hang a release on, and `gh release create` would CREATE the tag at
      // whatever HEAD happens to be — a release pointing at the wrong commit
      // is worse than a missing one.
      console.log(`  ${pkg.tag}: no tag — skipped`);
      skipped += 1;
      continue;
    }
    if (await releaseExists(pkg.tag)) {
      console.log(`  ${pkg.tag}: already released`);
      skipped += 1;
      continue;
    }
    const body = releaseBody(pkg);
    if (dryRun) {
      console.log(`  ${pkg.tag}: would create (${body.split("\n").length} line body)`);
      created += 1;
      continue;
    }
    const notes = `${process.env.RUNNER_TEMP ?? "/tmp"}/release-notes-${pkg.tag.replaceAll("/", "_")}.md`;
    await Bun.write(notes, `${body}\n`);
    const create = Bun.spawn(
      ["gh", "release", "create", pkg.tag, "--title", pkg.tag, "--notes-file", notes, "--latest=false", "--verify-tag"],
      { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
    );
    if ((await create.exited) !== 0) throw new Error(`could not create the release for ${pkg.tag}`);
    console.log(`  ${pkg.tag}: created`);
    created += 1;
  }
  console.log(`✓ ${created} release(s) ${dryRun ? "to create" : "created"}, ${skipped} already present or untagged`);
}
