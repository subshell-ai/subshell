import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every built-in plugin's declared icon must be a file the published package
 * actually carries.
 *
 * The icon route (`apps/server/api/src/api/plugins.route.ts`) resolves
 * `manifest.icon` against the INSTALLED plugin directory, and a registry
 * install gets that directory from the npm tarball — whose contents the
 * `files` array decides. A declared icon the array omits, or a file `files`
 * names that does not exist, means an npm-installed plugin answers 404 for
 * its mark and the Settings row silently falls back to the monogram. The
 * built-in seed copies from the repo working tree, so local dev NEVER sees
 * this class of mistake — which is exactly why netbird shipped `icon.png`
 * declared against a `files` entry of `icon.svg` (issue #64) unnoticed.
 *
 * Like `built-in-api-versions.test.ts`, manifests are read as data
 * (`readdirSync` + `JSON.parse`), never imported.
 */
const PLUGINS_DIR = join(import.meta.dir, "..", "..", "..", "plugins");

/** What one built-in's manifest declares about its icon. */
interface DeclaredIcon {
  /** Directory name, for the on-disk existence check. */
  dir: string;
  /** Package name, so a failure names the culprit. */
  name: string;
  /** `subshell.icon` as written, or undefined when the plugin declares none. */
  icon: string | undefined;
  /** The npm `files` array, or undefined when absent (npm then ships the whole directory). */
  files: string[] | undefined;
}

/**
 * Manifests whose declared icon would NOT reach the npm tarball.
 *
 * A `files` array decides what ships; npm's ABSENT-array default ships the
 * whole directory, so an absent array can never leave an icon out. An EMPTY
 * array is the opposite: it is an explicit list of nothing, and only package
 * defaults ship — so a declared icon IS left out, and that is a violation.
 */
function iconsLeftOutOfTarball(manifests: DeclaredIcon[]): DeclaredIcon[] {
  return manifests.filter((m) => m.icon !== undefined && m.files !== undefined && !m.files.includes(m.icon));
}

/** Reads every built-in's package.json from `packages/plugins/`. */
function readBuiltInManifests(): DeclaredIcon[] {
  return (
    readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      // Same skip as the apiVersion pin: a directory without a package.json is
      // not a built-in, and this guard must not die on ENOENT before any
      // assertion runs.
      .filter((entry) => existsSync(join(PLUGINS_DIR, entry.name, "package.json")))
      .map((entry) => {
        const raw = readFileSync(join(PLUGINS_DIR, entry.name, "package.json"), "utf8");
        const pkg = JSON.parse(raw) as { name?: string; files?: unknown; subshell?: { icon?: unknown } };
        return {
          dir: entry.name,
          name: pkg.name ?? entry.name,
          icon: typeof pkg.subshell?.icon === "string" ? pkg.subshell.icon : undefined,
          files: Array.isArray(pkg.files) ? (pkg.files as string[]) : undefined,
        };
      })
  );
}

describe("iconsLeftOutOfTarball", () => {
  const WITH_ICON = { dir: "x", name: "@subshell-ai/plugin-x", icon: "icon.png" };

  it("treats an ABSENT `files` array as shipping everything — npm ships the whole directory", () => {
    // Review nit on the #64 guard: the absent-array default was read backwards,
    // so a future icon-bearing built-in with no `files` would fail the guard
    // for a reason that is not true of its tarball.
    expect(iconsLeftOutOfTarball([{ ...WITH_ICON, files: undefined }])).toEqual([]);
  });

  it("treats an EMPTY `files` array as shipping nothing — the icon is left out", () => {
    expect(iconsLeftOutOfTarball([{ ...WITH_ICON, files: [] }])).toHaveLength(1);
  });

  it("passes the icon only when `files` names it", () => {
    expect(iconsLeftOutOfTarball([{ ...WITH_ICON, files: ["dist", "icon.png"] }])).toEqual([]);
    expect(iconsLeftOutOfTarball([{ ...WITH_ICON, files: ["dist", "icon.svg"] }])).toHaveLength(1);
  });
});

describe("built-in plugin icon manifests", () => {
  it("pins the number of plugins declaring an icon, so a silent disappearance is loud", () => {
    // Eight of the ten built-ins ship a mark (headscale and cloudflare-tunnel
    // declare none). A new icon-bearing built-in updates this number on purpose.
    expect(readBuiltInManifests().filter((m) => m.icon).length).toBe(8);
  });

  it("declares no icon that is absent from the npm `files` list", () => {
    const violations = iconsLeftOutOfTarball(readBuiltInManifests()).map(
      (m) => `${m.name} declares icon "${m.icon}" but its files array would leave it out of the tarball`,
    );
    expect(violations).toEqual([]);
  });

  it("lists in `files` no icon that is absent from the package directory", () => {
    for (const m of readBuiltInManifests()) {
      // The tarball is built from the package directory, so a `files` entry
      // matching nothing ships nothing — the other half of issue #64.
      for (const entry of m.files ?? []) {
        if (!entry.startsWith("icon.")) continue;
        expect(
          existsSync(join(PLUGINS_DIR, m.dir, entry)),
          `${m.name} files lists "${entry}" but the package directory has no such file`,
        ).toBe(true);
      }
    }
  });
});
