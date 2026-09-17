#!/usr/bin/env bun
/**
 * Keep every workspace's declared `license` equal to what its PATH implies.
 *
 * Subshell is dual-licensed on one axis and one axis only:
 *
 *     apps/server/**    AGPL-3.0-only   (the control plane)
 *     everything else   Apache-2.0
 *
 * That rule is stated in LICENSE, apps/server/LICENSE, NOTICE and the README,
 * and it is invisible in the place it actually gets broken: a new package.json
 * or Cargo.toml that simply omits `license`, or one that keeps the field it was
 * copy-pasted with after being moved across the line. Neither is a type error,
 * a lint error or a test failure, and every one of the fourteen workspaces here
 * had no `license` field at all until this script was written.
 *
 * A file's license is decided by where it lives, so the check is a pure
 * function of the path — there is no per-package list to maintain, and a
 * fifteenth workspace is covered the moment it exists.
 *
 * It then checks the thing the SPDX fields cannot see: the DEPENDENCY GRAPH.
 * An Apache package that depends on an AGPL one entangles the two licences,
 * and nothing else in the toolchain would object. Every such edge must be
 * listed in PERMITTED_CROSSINGS with a reason, and — because the reason is
 * always "it only touches the API Type Surface" — every import it makes of the
 * AGPL package must be TYPE-ONLY. That is what keeps the section 7 exception
 * in apps/server/LICENSE describing what the code actually does.
 *
 * Finally it checks what a PUBLISHED package hands its recipient: the licence
 * TEXT (an SPDX field is metadata; Apache-2.0 §4(a) asks for a copy) and the
 * three manifest fields that point back at the source. Those live here rather
 * than in a script of their own because this one already enumerates the
 * publishable manifests and already rewrites them under `--fix` — a second
 * script would duplicate both halves to check three keys — and because
 * "where did this come from" is the question a recipient asks right after
 * "what may I do with it".
 *
 *   bun scripts/license-fields.ts            # check (CI, pre-push)
 *   bun scripts/license-fields.ts --fix      # rewrite the wrong fields, write missing files
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

/**
 * Paths of the two per-runtime constant files.
 *
 * Declared HERE rather than beside the notice checks that use them: the
 * published-metadata stage reads `PRODUCT_URL` out of `legal.ts` at module
 * evaluation, and a `const` used before its declaration line is a temporal
 * dead zone rather than a hoisted binding — measured, as a crash on the first
 * run.
 */
const LEGAL_TS = "packages/subshell-protocol/src/legal.ts";
const LEGAL_RS = "crates/desktop-core/src/legal.rs";

/** SPDX identifier for the copyleft half. */
const AGPL = "AGPL-3.0-only";
/** SPDX identifier for everything else. */
const APACHE = "Apache-2.0";

/**
 * Repo-relative path prefix whose contents are AGPL. Deliberately a single
 * prefix: the vocabulary split (server / node / client) is what makes one
 * prefix sufficient, and a second entry here would mean the licence boundary
 * had stopped matching the directory taxonomy.
 */
const AGPL_PREFIX = "apps/server/";

/**
 * Manifests to check. `packages/tsconfig` and the like are included on purpose
 * — a shared config package is still distributed source.
 *
 * The one-level apps glob covers an app sitting directly under `apps/` rather
 * than inside a grouping directory — `apps/docs`, the taxonomy's one
 * exception. The licence still falls out of the path: `AGPL_PREFIX` can only
 * match the nested server grouping, so a top-level app is Apache and nothing
 * here changed about where the line is.
 */
const MANIFEST_GLOBS = [
  "package.json",
  "apps/*/package.json",
  "apps/*/*/package.json",
  "packages/*/package.json",
  "packages/plugins/*/package.json",
  "e2e/package.json",
  "crates/*/Cargo.toml",
  "apps/*/*/src-tauri/Cargo.toml",
];

/** One manifest, what it declares, and what its path says it should declare. */
interface Manifest {
  /** Repo-relative path, e.g. `apps/server/api/package.json`. */
  path: string;
  /** `json` for package.json, `toml` for Cargo.toml — they are edited differently. */
  kind: "json" | "toml";
  /** The SPDX id currently declared, or undefined when the field is absent. */
  declared: string | undefined;
  /** The SPDX id the path requires. */
  expected: string;
  /** The manifest's own directory, repo-relative — where its LICENSE belongs. */
  dir: string;
  /** Whether `npm publish` would ship it, i.e. a package.json without `private: true`. */
  published: boolean;
}

/** The licence a path is under, from the path alone. */
function expectedLicense(repoRelativePath: string): string {
  return repoRelativePath.startsWith(AGPL_PREFIX) ? AGPL : APACHE;
}

/** Reads the `license` a manifest declares, or undefined if it declares none. */
function readDeclared(source: string, kind: Manifest["kind"]): string | undefined {
  if (kind === "json") {
    const parsed = JSON.parse(source) as { license?: string };
    return parsed.license;
  }
  // Only the `[package]` table carries `license`, and it is the first table in
  // every Cargo.toml here; a bare line match is enough and avoids a TOML parser.
  return source.match(/^license\s*=\s*"([^"]*)"/m)?.[1];
}

/** Collects every manifest with its declared and expected licence. */
function collect(): Manifest[] {
  const found: Manifest[] = [];
  for (const pattern of MANIFEST_GLOBS) {
    for (const match of new Glob(pattern).scanSync({ cwd: REPO_ROOT, absolute: false })) {
      const path = match.replaceAll("\\", "/");
      const kind = path.endsWith("Cargo.toml") ? "toml" : "json";
      const source = readFileSync(resolve(REPO_ROOT, path), "utf8");
      // `private: true` is npm's own word for "never published", so it is the
      // right test rather than a list of package names to keep in step.
      const published = kind === "json" && (JSON.parse(source) as { private?: boolean }).private !== true;
      found.push({
        path,
        kind,
        declared: readDeclared(source, kind),
        expected: expectedLicense(path),
        dir: path.slice(0, path.lastIndexOf("/")) || ".",
        published,
      });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Inserts a `license` line into a package.json after `version`, or after `name`
 * when there is no `version`.
 *
 * That position is not cosmetic: it is the slot syncpack's `sortFirst` gives
 * `license`, so anywhere else leaves the next `syncpack:format` with a diff to
 * make. The anchor line may or may not end in a comma — `version` is the last
 * key in a minimal manifest — and the inserted line has to carry the comma
 * that the anchor then gives up.
 */
function insertJsonLicense(source: string, spdx: string): string | undefined {
  for (const key of ["version", "name"]) {
    const anchor = new RegExp(`^([ \\t]*)"${key}": ([^\\n]*?)(,?)$`, "m");
    const match = source.match(anchor);
    if (!match) continue;
    const [line, indent, value, comma] = match;
    // No comma on the anchor means it was the last key, so `license` inherits
    // that position and the anchor gains the comma it lacked.
    const replacement = comma
      ? `${indent}"${key}": ${value},\n${indent}"license": "${spdx}",`
      : `${indent}"${key}": ${value},\n${indent}"license": "${spdx}"`;
    return source.replace(line, replacement);
  }
  return undefined;
}

/** Inserts a `license` line into a Cargo.toml after `version`, or after `name`. */
function insertTomlLicense(source: string, spdx: string): string | undefined {
  for (const key of ["version", "name"]) {
    const anchor = new RegExp(`^${key}\\s*=\\s*"[^"]*"$`, "m");
    const match = source.match(anchor);
    if (!match) continue;
    return source.replace(match[0], `${match[0]}\nlicense = "${spdx}"`);
  }
  return undefined;
}

/** Writes the correct `license` into one manifest, inserting the field if absent. */
function fix(manifest: Manifest): void {
  const absolute = resolve(REPO_ROOT, manifest.path);
  const source = readFileSync(absolute, "utf8");

  const updated =
    manifest.declared !== undefined
      ? manifest.kind === "toml"
        ? source.replace(/^license\s*=\s*"[^"]*"$/m, `license = "${manifest.expected}"`)
        : source.replace(/^([ \t]*)"license": "[^"]*"/m, `$1"license": "${manifest.expected}"`)
      : manifest.kind === "toml"
        ? insertTomlLicense(source, manifest.expected)
        : insertJsonLicense(source, manifest.expected);

  if (updated === undefined || updated === source) {
    throw new Error(`could not place license in ${manifest.path}`);
  }
  writeFileSync(absolute, updated);
}

// ---------------------------------------------------------------------------
// Stage 2: the dependency graph
// ---------------------------------------------------------------------------

/**
 * Apache→AGPL dependency edges that are allowed to exist, each with the reason
 * it is sound. Anything not listed here fails.
 *
 * Every entry is permitted on the same ground — it consumes only the API Type
 * Surface that apps/server/LICENSE carves out of the AGPL under section 7 — so
 * every entry is additionally held to `valueImportsOf`. An edge that
 * starts importing runtime code has outgrown its reason, and the check says so
 * rather than letting the licence text quietly become false.
 */
const PERMITTED_CROSSINGS: Record<string, string> = {
  "packages/backend-client -> @internal/server":
    "Eden Treaty infers the client from the server's exported `App` type. The import is " +
    "type-only and the built dist/index.d.ts contains no server source — only an " +
    "unresolved module reference. Covered by the API Type Surface exception.",
  "e2e -> @internal/server":
    "Build ordering only: e2e spawns the server as a SUBPROCESS (`bun run src/index.ts`) " +
    "and imports nothing from it. Running a program is not restricted by the AGPL (§2).",
  "e2e -> @internal/server-web": "Build ordering only: e2e needs the SPA built before Playwright drives it. No import.",
};

/** A workspace's name, its path, and the licence its path implies. */
interface Workspace {
  /** The npm package name, e.g. `@internal/server`. */
  name: string;
  /** Repo-relative directory, e.g. `apps/server/api`. */
  dir: string;
  /** SPDX id its path implies. */
  license: string;
  /** Every internal package it declares, prod and dev alike. */
  dependencies: string[];
}

/** Reads every workspace package.json into a name→metadata record. */
function collectWorkspaces(): Workspace[] {
  const workspaces: Workspace[] = [];
  for (const pattern of [
    "apps/*/package.json",
    "apps/*/*/package.json",
    "packages/*/package.json",
    "packages/plugins/*/package.json",
    "e2e/package.json",
  ]) {
    for (const match of new Glob(pattern).scanSync({ cwd: REPO_ROOT, absolute: false })) {
      const path = match.replaceAll("\\", "/");
      const parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const dir = path.replace(/\/package\.json$/, "");
      workspaces.push({
        name: parsed.name,
        dir,
        license: expectedLicense(`${dir}/`),
        dependencies: [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})].filter(
          (d) => d.startsWith("@internal/"),
        ),
      });
    }
  }
  return workspaces;
}

/** Every source file in a workspace, skipping build output and dependencies. */
function sourceFiles(dir: string): string[] {
  const glob = new Glob("**/*.{ts,tsx}");
  return [...glob.scanSync({ cwd: resolve(REPO_ROOT, dir), absolute: false })]
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !/(^|\/)(node_modules|dist|\.turbo|build)\//.test(f));
}

/**
 * Reports any import of `pkg` in `dir` that pulls in more than types.
 *
 * `import type {…}` and `export type {…}` are type-only outright; a plain
 * `import {…}` qualifies only when EVERY specifier carries its own `type`
 * modifier. A side-effect import (`import "pkg"`) never qualifies — it emits a
 * real runtime require.
 */
function valueImportsOf(pkg: string, dir: string): string[] {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The clause may span lines (a braced specifier list often does) but must not
  // cross a statement boundary — without excluding quotes and semicolons the
  // lazy match happily starts at the PREVIOUS import and swallows it, reporting
  // an adjacent `import { treaty } from "@elysiajs/eden"` as this package's
  // value import.
  const statement = new RegExp(
    `(?:^|\\n)\\s*(?:(import|export)\\s+([^"';]*?)\\s+from\\s*|import\\s*)["']${escaped}["']`,
    "g",
  );
  const offenders: string[] = [];

  for (const file of sourceFiles(dir)) {
    const source = readFileSync(resolve(REPO_ROOT, dir, file), "utf8");
    for (const match of source.matchAll(statement)) {
      const clause = match[2]?.trim();
      // `import "pkg"` — no clause at all, so it is a side-effect import.
      if (clause === undefined) {
        offenders.push(`${dir}/${file}: side-effect import`);
        continue;
      }
      if (clause.startsWith("type ") || clause === "type") continue;
      const braced = clause.match(/^\{([\s\S]*)\}$/);
      const specifiers = braced?.[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (specifiers?.every((s) => s.startsWith("type "))) continue;
      offenders.push(`${dir}/${file}: ${match[0].trim().replace(/\s+/g, " ")}`);
    }
  }
  return offenders;
}

/** Every Apache→AGPL edge, split into permitted and unlisted. */
function auditGraph(workspaces: Workspace[]): { unlisted: string[]; leaks: string[] } {
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const unlisted: string[] = [];
  const leaks: string[] = [];

  for (const consumer of workspaces) {
    if (consumer.license !== APACHE) continue;
    for (const dependency of consumer.dependencies) {
      if (byName.get(dependency)?.license !== AGPL) continue;
      const edge = `${consumer.dir} -> ${dependency}`;
      if (!(edge in PERMITTED_CROSSINGS)) {
        unlisted.push(edge);
        continue;
      }
      leaks.push(...valueImportsOf(dependency, consumer.dir).map((o) => `${edge}\n      ${o}`));
    }
  }
  return { unlisted, leaks };
}

// ---------------------------------------------------------------------------
// Stage 3: the human-facing notices
// ---------------------------------------------------------------------------

/**
 * The copyright line, as three files independently spell it.
 *
 * Two runtimes cannot share a constant, so the TypeScript and Rust halves are
 * duplicated by necessity and the root LICENSE is a third copy in prose. A
 * drifted copyright line is invisible — nobody re-reads an About box — and it
 * is the one string that has to be right, because it names who owns the work.
 */
const NOTICE_SOURCES: { path: string; pattern: RegExp; what: string }[] = [
  {
    path: "packages/subshell-protocol/src/legal.ts",
    pattern: /^export const COPYRIGHT_LINE = `Copyright \$\{COPYRIGHT_YEAR\} \$\{COPYRIGHT_HOLDER\}`;$/m,
    what: "template",
  },
  {
    path: "crates/desktop-core/src/legal.rs",
    pattern: /^pub const COPYRIGHT_LINE: &str = "(?<line>[^"]+)";$/m,
    what: "literal",
  },
  { path: "LICENSE", pattern: /^(?<line>Copyright \d{4} .+)$/m, what: "literal" },
  { path: "NOTICE", pattern: /^(?<line>Copyright \d{4} .+)$/m, what: "literal" },
  { path: "apps/server/LICENSE", pattern: /^Copyright \(C\) (?<line>\d{4} .+)$/m, what: "agpl" },
];

/** One `export const NAME = "value";` from legal.ts, unwrapped if biome split it. */
function legalConstant(name: string): string {
  const source = readFileSync(resolve(REPO_ROOT, LEGAL_TS), "utf8").replace(/=\n\s+"/g, '= "');
  const value = source.match(new RegExp(`^export const ${name} = "([^"]*)";$`, "m"))?.[1];
  if (value === undefined) throw new Error(`legal.ts: ${name} not found`);
  return value;
}

/** The product site, as `legal.ts` states it — not a second copy of the URL. */
const PRODUCT_URL = legalConstant("PRODUCT_URL");

/** Reads the TS holder/year, which are assembled rather than written out. */
function typescriptCopyrightLine(): string {
  const source = readFileSync(resolve(REPO_ROOT, "packages/subshell-protocol/src/legal.ts"), "utf8");
  const holder = source.match(/^export const COPYRIGHT_HOLDER = "([^"]+)";$/m)?.[1];
  const year = source.match(/^export const COPYRIGHT_YEAR = "([^"]+)";$/m)?.[1];
  if (!holder || !year) throw new Error("legal.ts: COPYRIGHT_HOLDER/COPYRIGHT_YEAR not found");
  return `Copyright ${year} ${holder}`;
}

/**
 * Every plain string constant the TS and Rust files BOTH declare, and whether
 * they agree.
 *
 * Enumerating the shared names rather than checking a hand-written list: a
 * constant added to one file and forgotten in the other is the likely mistake,
 * and this reports the ones that exist in both and disagree without anyone
 * having to remember to extend the check. `COPYRIGHT_LINE` is excluded — the TS
 * side assembles it from a template, so it is compared by `collectNotices`.
 */
function sharedConstantDisagreements(): string[] {
  const read = (path: string, pattern: RegExp): Map<string, string> => {
    // Unwrap a declaration biome split across two lines before matching, so
    // `export const X =\n  "…";` is the same input as the one-line form.
    const source = readFileSync(resolve(REPO_ROOT, path), "utf8").replace(/=\n\s+"/g, '= "');
    const found = new Map<string, string>();
    for (const match of source.matchAll(pattern)) {
      const [, name, value] = match;
      if (name !== "COPYRIGHT_LINE") found.set(name, value);
    }
    return found;
  };
  // `\s*` between the `=` and the string, because biome wraps a long constant
  // onto the next line — which the single-line form silently skipped, so a
  // long shared string (the licence exception summary is 200 characters) was
  // invisible to the very check that exists to keep the two copies equal.
  const ts = read(LEGAL_TS, /^export const ([A-Z_]+) =\s*"([^"]*)";$/gm);
  const rs = read(LEGAL_RS, /^pub const ([A-Z_]+): &str =\s*"([^"]*)";$/gm);

  const problems: string[] = [];
  for (const [name, value] of ts) {
    const other = rs.get(name);
    if (other === undefined) continue; // TS-only (e.g. the exception summary)
    if (other !== value) {
      problems.push(`${name}\n      ${LEGAL_TS}: ${value}\n      ${LEGAL_RS}: ${other}`);
    }
  }
  return problems;
}

/** Every file's copyright line, keyed by path, for comparison. */
function collectNotices(): { path: string; line: string }[] {
  const found: { path: string; line: string }[] = [];
  for (const source of NOTICE_SOURCES) {
    if (source.what === "template") {
      // The TS constant is built from two others; compare the assembled value.
      found.push({ path: source.path, line: typescriptCopyrightLine() });
      continue;
    }
    const text = readFileSync(resolve(REPO_ROOT, source.path), "utf8");
    const match = text.match(source.pattern);
    if (!match) throw new Error(`${source.path}: no copyright line matched`);
    const line = match.groups?.line ?? "";
    // apps/server/LICENSE writes the GNU-conventional `Copyright (C) <year>
    // <holder>`; normalise so it compares against the others.
    found.push({ path: source.path, line: source.what === "agpl" ? `Copyright ${line}` : line });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Stage 4: the licence text a PUBLISHED package actually ships
// ---------------------------------------------------------------------------

/**
 * Every non-private manifest must carry a LICENSE file beside it.
 *
 * The SPDX field in a package.json is metadata: it tells a licence scanner
 * what the terms are, and it hands a recipient nothing. Apache-2.0 §4(a) is
 * explicit that distributing the work means giving recipients a COPY of the
 * licence, and `npm publish` is distribution — of a tarball that, for these
 * seven packages, held `dist/`, a README and a package.json saying
 * "Apache-2.0" with no terms anywhere in it.
 *
 * npm includes a root `LICENSE` in the tarball automatically, whatever `files`
 * says, so the fix is the file existing. This check is what stops the eighth
 * published package from shipping without one — nothing else would notice,
 * because a missing licence is not a build error, a type error or a failing
 * test, and the tarball installs perfectly.
 *
 * The CLIs are the deliberate exception and are not manifests at all: they
 * ship as bare single-file binaries with nowhere to put a file beside them,
 * which is what their `license` subcommand is for (`legal.ts`).
 */
const PACKAGE_LICENSE = "LICENSE";

/**
 * The Apache-2.0 text every published package ships, taken from the root
 * LICENSE rather than stored a second time.
 *
 * The root file opens with the dual-licence explanation and then the full
 * Apache text after a rule of `=`. A package under `packages/` is wholly
 * Apache-2.0, so it gets the text and the copyright line and NOT the preamble
 * — telling someone who installed `@subshell-ai/plugin-api` that some other
 * directory is AGPL invites exactly the confusion the split exists to avoid.
 */
function canonicalPackageLicense(): string {
  const root = readFileSync(resolve(REPO_ROOT, "LICENSE"), "utf8");
  const start = root.indexOf("                                 Apache License");
  if (start === -1) throw new Error("LICENSE: the Apache text no longer starts where this script expects");
  return `${typescriptCopyrightLine()}\n\n${root.slice(start).trimEnd()}\n`;
}

/** Publishable packages whose LICENSE file is missing or has drifted. */
function licenseTextProblems(manifests: Manifest[]): { path: string; why: string }[] {
  const expected = canonicalPackageLicense();
  const problems: { path: string; why: string }[] = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "json" || !manifest.published) continue;
    const path = `${manifest.dir}/${PACKAGE_LICENSE}`;
    let actual: string;
    try {
      actual = readFileSync(resolve(REPO_ROOT, path), "utf8");
    } catch {
      problems.push({ path, why: "missing" });
      continue;
    }
    if (actual !== expected) problems.push({ path, why: "differs from the root LICENSE's Apache text" });
  }
  return problems;
}

/** Write the canonical text to a package that is missing it or has drifted. */
function fixLicenseText(path: string): void {
  writeFileSync(resolve(REPO_ROOT, path), canonicalPackageLicense());
}

// ---------------------------------------------------------------------------
// Stage 5: where a published package says it came from
// ---------------------------------------------------------------------------

/** The repository every published package points back at. */
const REPO_URL = "https://github.com/subshell-ai/subshell";

/**
 * The metadata a published package owes its recipient, beyond the terms.
 *
 * Without `repository`, npm renders the package page with no link to any
 * source at all — so the licence, the NOTICE and the code it describes are
 * reachable only by guessing. `directory` is what makes that link land on the
 * package inside this monorepo rather than on the root, and npm's provenance
 * UI reads it too. `homepage` and `bugs` are the other two questions a package
 * page is asked, and neither is derivable from anything else in the manifest.
 *
 * Values are derived from the path, like the SPDX field above: nothing here is
 * a per-package decision, so there is no list to maintain and an eighth
 * package is covered the moment it exists.
 */
function expectedMetadata(dir: string): Record<string, unknown> {
  return {
    // `git+https`, the form npm normalizes to and the one its UI links from.
    repository: { type: "git", url: `git+${REPO_URL}.git`, directory: dir },
    homepage: PRODUCT_URL,
    bugs: { url: `${REPO_URL}/issues` },
  };
}

/** Published manifests whose pointer-back fields are missing or wrong. */
function metadataProblems(manifests: Manifest[]): { path: string; missing: string[] }[] {
  const problems: { path: string; missing: string[] }[] = [];
  for (const manifest of manifests) {
    if (manifest.kind !== "json" || !manifest.published) continue;
    const declared = JSON.parse(readFileSync(resolve(REPO_ROOT, manifest.path), "utf8")) as Record<string, unknown>;
    const expected = expectedMetadata(manifest.dir);
    const missing = Object.keys(expected).filter(
      (key) => JSON.stringify(declared[key]) !== JSON.stringify(expected[key]),
    );
    if (missing.length > 0) problems.push({ path: manifest.path, missing });
  }
  return problems;
}

/**
 * Write the pointer-back fields into a manifest.
 *
 * Inserted after `types` (or, failing that, after `license`) because that is
 * the slot `syncpack.config.js`'s `sortFirst` gives them — anywhere else and
 * the next `syncpack:format` has a diff to make. Re-serialized wholesale
 * rather than spliced line-by-line like the SPDX field, since three keys, two
 * of them objects, is past what a line insert can do honestly.
 */
function fixMetadata(path: string, dir: string): void {
  const full = resolve(REPO_ROOT, path);
  const declared = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
  const expected = expectedMetadata(dir);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(declared)) {
    if (key in expected) continue; // re-added in the canonical position below
    out[key] = value;
    if (key === "types" || (key === "license" && !("types" in declared))) Object.assign(out, expected);
  }
  // A manifest with neither anchor still gets them, at the end.
  for (const [key, value] of Object.entries(expected)) if (!(key in out)) out[key] = value;
  writeFileSync(full, `${JSON.stringify(out, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const shouldFix = process.argv.includes("--fix");
const manifests = collect();
const wrong = manifests.filter((m) => m.declared !== m.expected);

if (shouldFix) {
  for (const manifest of wrong) {
    fix(manifest);
    console.log(`  ${manifest.path}: ${manifest.declared ?? "(none)"} → ${manifest.expected}`);
  }
  const missingText = licenseTextProblems(manifests);
  for (const problem of missingText) {
    fixLicenseText(problem.path);
    console.log(`  ${problem.path}: ${problem.why} → written`);
  }
  const missingMeta = metadataProblems(manifests);
  for (const problem of missingMeta) {
    const manifest = manifests.find((m) => m.path === problem.path);
    if (manifest) fixMetadata(manifest.path, manifest.dir);
    console.log(`  ${problem.path}: ${problem.missing.join(", ")} → written`);
  }
  const total = wrong.length + missingText.length + missingMeta.length;
  console.log(total ? `✓ fixed ${total} file(s)` : "✓ nothing to fix");
  process.exit(0);
}

let failed = false;

if (wrong.length > 0) {
  failed = true;
  console.error(`✗ ${wrong.length} manifest(s) declare the wrong licence for their path:\n`);
  for (const manifest of wrong) {
    console.error(`  ${manifest.path}`);
    console.error(`      declared: ${manifest.declared ?? "(no license field)"}`);
    console.error(`      expected: ${manifest.expected}`);
  }
  console.error(`\n  ${AGPL_PREFIX}** is ${AGPL}; everything else is ${APACHE}.`);
  console.error("  Run `bun run lint:licenses:fix` to correct them.\n");
} else {
  console.log(`✓ ${manifests.length} manifests declare the licence their path implies`);
}

const workspaces = collectWorkspaces();
const { unlisted, leaks } = auditGraph(workspaces);

if (unlisted.length > 0) {
  failed = true;
  console.error(`✗ ${unlisted.length} unlisted ${APACHE}→${AGPL} dependency edge(s):\n`);
  for (const edge of unlisted) console.error(`  ${edge}`);
  console.error(
    "\n  An Apache package depending on an AGPL one entangles the two licences.\n" +
      "  Either drop the dependency, move the consumer under apps/server/, or — if it\n" +
      "  genuinely touches only the API Type Surface — add it to PERMITTED_CROSSINGS\n" +
      `  in ${"scripts/license-fields.ts"} with the reason.\n`,
  );
}

if (leaks.length > 0) {
  failed = true;
  console.error(`✗ ${leaks.length} permitted edge(s) import more than types:\n`);
  for (const leak of leaks) console.error(`  ${leak}`);
  console.error(
    "\n  These edges are allowed only because they consume the API Type Surface, which\n" +
      "  apps/server/LICENSE carves out of the AGPL under section 7. A value import is\n" +
      "  outside that carve-out. Make it `import type`, or reconsider the edge.\n",
  );
}

const missingLicenseText = licenseTextProblems(manifests);
if (missingLicenseText.length > 0) {
  failed = true;
  console.error(`✗ ${missingLicenseText.length} published package(s) ship no correct licence text:\n`);
  for (const problem of missingLicenseText) console.error(`  ${problem.path}: ${problem.why}`);
  console.error(
    "\n  A published package's `license` field is metadata; Apache-2.0 §4(a) asks for a\n" +
      "  COPY of the terms, and `npm publish` is distribution. npm ships a root LICENSE\n" +
      "  automatically, so the file existing is the whole fix.\n" +
      "  Run `bun run lint:licenses:fix` to write them.\n",
  );
} else {
  const shipped = manifests.filter((m) => m.published).length;
  console.log(`✓ all ${shipped} published packages ship the Apache-2.0 text`);
}

const metaProblems = metadataProblems(manifests);
if (metaProblems.length > 0) {
  failed = true;
  console.error(`✗ ${metaProblems.length} published package(s) do not point back at their source:\n`);
  for (const problem of metaProblems) console.error(`  ${problem.path}: ${problem.missing.join(", ")}`);
  console.error(
    "\n  Without `repository` npm renders the package page with no link to any source,\n" +
      "  so the licence, the NOTICE and the code are reachable only by guessing; the\n" +
      "  `directory` member is what lands that link on the package rather than the root.\n" +
      "  Run `bun run lint:licenses:fix` to write them.\n",
  );
} else {
  console.log("✓ every published package points back at its source");
}

const constantProblems = sharedConstantDisagreements();
if (constantProblems.length > 0) {
  failed = true;
  console.error(`✗ ${constantProblems.length} constant(s) disagree between the TS and Rust copies:\n`);
  for (const problem of constantProblems) console.error(`  ${problem}`);
  console.error("");
}

const notices = collectNotices();
const distinct = [...new Set(notices.map((n) => n.line))];
if (distinct.length > 1) {
  failed = true;
  console.error(`✗ the copyright line disagrees across ${notices.length} files:\n`);
  for (const notice of notices) console.error(`  ${notice.path}\n      ${notice.line}`);
  console.error(
    "\n  These are separate copies by necessity (two runtimes, plus prose), so\n  nothing but this check keeps them equal.\n",
  );
} else {
  console.log(`✓ "${distinct[0]}" agrees across ${notices.length} files`);
  console.log("✓ every constant shared by legal.ts and legal.rs agrees");
}

if (!failed) {
  const permitted = Object.keys(PERMITTED_CROSSINGS).length;
  console.log(`✓ no ${APACHE}→${AGPL} edges beyond the ${permitted} permitted, type-only ones`);
}

process.exit(failed ? 1 : 0);
