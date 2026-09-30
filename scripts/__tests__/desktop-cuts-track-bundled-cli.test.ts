import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Each desktop bundle SHIPS the CLI it wraps, so a CLI release without the
 * matching desktop release leaves desktop users behind (cli-server v1.7.0
 * shipped on 2026-09-30 with no desktop-server cut, because nothing
 * mechanically linked the two). The link is now three facts that must stay
 * true together, and this file pins all three per app: the Tauri config
 * names the sidecar, the app's package.json declares the CLI it bundles as a
 * workspace dependency, and the changesets config propagates CLI bumps to
 * every internal dependent ("always"), which is what turns that edge into an
 * automatic desktop bump in the version PR.
 */

const ROOT = join(import.meta.dir, "..", "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;
}

interface Bundle {
  /** The desktop app package (path under the repo root). */
  dir: string;
  /** The sidecar name Tauri externalizes (renamed only with a release). */
  sidecar: string;
  /** The CLI package whose binary that sidecar is built from. */
  cli: string;
}

const BUNDLES: Bundle[] = [
  { dir: "apps/server/desktop", sidecar: "binaries/subshell-server-bundled", cli: "@internal/server" },
  { dir: "apps/client/desktop", sidecar: "binaries/subshell-node-bundled", cli: "@internal/node" },
];

describe("desktop cuts track the CLI they bundle", () => {
  test("the changesets config propagates bumps to internal dependents", () => {
    const config = readJson(".changeset/config.json");
    const experimental = config["___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH"] as
      | Record<string, unknown>
      | undefined;
    expect(experimental?.updateInternalDependents).toBe("always");
  });

  for (const bundle of BUNDLES) {
    describe(bundle.dir, () => {
      test("the tauri config externalizes the named sidecar", () => {
        const tauri = readJson(`${bundle.dir}/src-tauri/tauri.conf.json`);
        const bundleCfg = tauri.bundle as { externalBin?: string[] };
        expect(bundleCfg.externalBin ?? []).toContain(bundle.sidecar);
      });

      test(`package.json declares ${bundle.cli} as a workspace dependency`, () => {
        const pkg = readJson(`${bundle.dir}/package.json`);
        const deps = pkg.dependencies as Record<string, string>;
        // The edge is what assemble-release-plan walks; "workspace:*" is the
        // only spelling, and it lives in dependencies (not dev) because the
        // shipped binary IS the dependency.
        expect(deps[bundle.cli]).toBe("workspace:*");
      });
    });
  }
});
