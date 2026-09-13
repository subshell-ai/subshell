import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@subshell-ai/plugin-api";

/**
 * Every built-in plugin's declared `subshell.apiVersion`, pinned to the
 * version this host implements.
 *
 * Built-ins are imported STATICALLY (AGENTS.md), and `parseManifest` only
 * refuses a version ABOVE the host's — so a built-in left declaring
 * `apiVersion: 1` after a contract bump loads silently forever. Nothing else
 * in the repo catches that drift; this pin is the whole guard.
 *
 * The manifests are read as data, not imported: a package.json is not a
 * module (and the repo bans dynamic import anyway), so this is `readdirSync`
 * + `JSON.parse` over `packages/plugins/*`.
 */
const PLUGINS_DIR = join(import.meta.dir, "..", "..", "..", "plugins");

/** What one built-in's manifest declares. */
interface DeclaredVersion {
  /** Package name, so a failure names the culprit. */
  name: string;
  /** `subshell.apiVersion` exactly as written in the manifest. */
  apiVersion: unknown;
}

/** Reads every built-in's package.json from `packages/plugins/`. */
function readBuiltInManifests(): DeclaredVersion[] {
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const raw = readFileSync(join(PLUGINS_DIR, entry.name, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as { name?: string; subshell?: { apiVersion?: unknown } };
      return { name: pkg.name ?? entry.name, apiVersion: pkg.subshell?.apiVersion };
    });
}

describe("built-in plugin manifests", () => {
  it("pins each built-in's declared apiVersion to the host's PLUGIN_API_VERSION", () => {
    const manifests = readBuiltInManifests();
    // The six built-ins that ship (AGENTS.md). Asserted so a broken path —
    // or a built-in whose `subshell` block went missing — fails loudly here
    // rather than passing vacuously over a shorter list. A seventh built-in
    // updates this number on purpose.
    expect(manifests.length).toBe(6);
    for (const m of manifests) {
      expect(m.apiVersion, `${m.name} declares a stale subshell.apiVersion`).toBe(PLUGIN_API_VERSION);
    }
  });
});
