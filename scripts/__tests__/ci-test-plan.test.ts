import { describe, expect, test } from "bun:test";
import { allFlags, computePlan, scriptsTouched, type AffectedPackage } from "../ci-test-plan";

const pkg = (name: string, dir: string): AffectedPackage => ({ name, dir });

describe("computePlan", () => {
  test("routes each registered workspace to exactly its slice", () => {
    const cases: [AffectedPackage, keyof ReturnType<typeof allFlags>][] = [
      [pkg("@internal/server-web", "apps/server/web"), "web"],
      [pkg("@internal/mobile", "apps/client/mobile"), "mobile"],
      [pkg("@internal/desktop-server", "apps/server/desktop"), "desktop"],
      [pkg("@internal/desktop-client", "apps/client/desktop"), "desktop"],
      [pkg("@internal/server", "apps/server/api"), "serverNode"],
      [pkg("@internal/node", "apps/node/agent"), "serverNode"],
      [pkg("@internal/e2e", "e2e"), "e2e"],
    ];
    for (const [p, slice] of cases) {
      const { flags } = computePlan([p], []);
      for (const key of ["web", "mobile", "desktop", "serverNode", "packages", "scripts", "e2e"] as const) {
        // Every named-package slice routes ALONE; `scripts` stays closed with
        // an empty changed-file list. `smoke` is excluded because server ∈
        // affected is ITS trigger too — its own test below pins that pair.
        expect(flags[key]).toBe(key === slice);
      }
      expect(flags.smoke).toBe(p.name === "@internal/server");
    }
  });

  test("any package under packages/ opens the packages slice, nested plugins included", () => {
    const { flags } = computePlan([pkg("@subshell-ai/plugin-tailscale", "packages/plugins/tailscale")], []);
    expect(flags.packages).toBe(true);
    expect(flags.web).toBe(false);
    // ...and the dependent half is turbo's job, not ours: the affected SET
    // arrives with dependents already expanded, so a protocol change reaching
    // web arrives here as server-web ∈ affected, tested by the case above.
  });

  test("the root pseudo-package in the affected set runs everything", () => {
    // A changed global input (bun.lock, root tsconfig/biome, turbo.json)
    // invalidates every hash; no slice may claim exemption.
    const { flags, reason } = computePlan([pkg("//", "")], ["bun.lock"]);
    expect(Object.values(flags).every(Boolean)).toBe(true);
    expect(reason).toContain("global");
  });

  test("an affected package with no registered slice runs everything", () => {
    // The failure this guard exists for: someone adds a workspace and forgets
    // to route it. Skipping its tests silently is the one wrong answer.
    const { flags, reason } = computePlan([pkg("@internal/brand-new", "brand-new")], []);
    expect(Object.values(flags).every(Boolean)).toBe(true);
    expect(reason).toContain("brand-new");
  });

  test("server in the affected set lights the smoke; a scripts change lights it too", () => {
    const server = computePlan([pkg("@internal/server", "apps/server/api")], ["apps/server/api/src/x.ts"]);
    expect(server.flags.smoke).toBe(true);
    // The smoke job runs scripts/smoke-mcp-refusal.sh; a change THERE must
    // run the smoke even though no package imported it.
    const script = computePlan([], ["scripts/smoke-mcp-refusal.sh"]);
    expect(script.flags.smoke).toBe(true);
    expect(script.flags.scripts).toBe(true);
    expect(script.flags.serverNode).toBe(false);
  });

  test("a docs-only diff answers every slice false", () => {
    const { flags } = computePlan([], ["docs/superpowers/specs/x.md", "README.md"]);
    expect(Object.values(flags).every((v) => v === false)).toBe(true);
  });

  test("the empty affected set with real changes still routes scripts by files", () => {
    // e.g. a .github/workflows change touches no workspace but IS a change;
    // scripts must not run for it, docs-only rules above already exclude it.
    const { flags } = computePlan([], [".github/workflows/lint.yml"]);
    expect(flags.scripts).toBe(false);
    expect(flags.web).toBe(false);
  });
});

describe("scriptsTouched", () => {
  test("fires on the files the script suites actually read", () => {
    for (const f of [
      "scripts/lockfile-workspace-versions.ts",
      "bun.lock",
      "package.json",
      "turbo.json",
      "biome.jsonc",
      ".changeset/config.json",
      "packages/plugins/netbird/package.json",
      "packages/subshell-protocol/package.json",
      "apps/server/api/package.json",
      "e2e/package.json",
      // the design linter reads the token files; their drift fails its suites
      "apps/server/web/src/styles/tokens.css",
      // license-fields walks Cargo.toml under apps/ — covered by the apps/ rule
      "apps/server/desktop/src-tauri/Cargo.toml",
    ]) {
      expect(scriptsTouched([f])).toBe(true);
    }
  });

  test("stays quiet for files no script reads", () => {
    for (const f of [
      "docs/anything.md",
      "README.md",
      "AGENTS.md",
      ".github/workflows/test.yml",
      "crates/desktop-core/src/lib.rs",
    ]) {
      expect(scriptsTouched([f])).toBe(false);
    }
  });
});
