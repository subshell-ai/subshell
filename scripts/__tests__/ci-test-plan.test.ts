import { describe, expect, test } from "bun:test";
import { type AffectedPackage, type allFlags, computePlan, rustTouched, scriptsTouched } from "../ci-test-plan";

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
      // The website's suites run inside the Scripts job, so its package
      // routes there by NAME — an unregistered website would fail-wide.
      [pkg("@internal/website", "apps/website"), "scripts"],
    ];
    for (const [p, slice] of cases) {
      const { flags } = computePlan([p], []);
      for (const key of [
        "web",
        "mobile",
        "desktop",
        "serverNode",
        "packages",
        "scripts",
        "e2e",
        "rustCore",
        "rustApps",
      ] as const) {
        // Every named-package slice routes ALONE; `scripts` stays closed for
        // the other packages with an empty changed-file list, and opens for
        // website from the registration alone (`||=`, not `=`). `smoke` is
        // excluded because server ∈ affected is ITS trigger too — its own
        // test below pins that pair. The Rust pair is IN because nothing
        // routes there by package: an affected set with no files must find
        // both false.
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

  test("a crates/desktop-core change lights BOTH Rust slices", () => {
    // Path dependency, measured in each src-tauri/Cargo.toml
    // (`subshell-desktop-core = { path = ... }`): the apps compile the core,
    // so its change must relight their legs. Nothing else moves — crates/ is
    // no package's dir and no script reads it.
    const { flags } = computePlan([], ["crates/desktop-core/src/lib.rs"]);
    expect(flags.rustCore).toBe(true);
    expect(flags.rustApps).toBe(true);
    expect(Object.entries(flags).every(([k, v]) => (k === "rustCore" || k === "rustApps") === v)).toBe(true);
  });

  test("an app's src-tauri change lights its slice only", () => {
    // NOT core: the three Cargo projects are independent (each its own
    // Cargo.lock, no root workspace) and core depends on neither app.
    // `scripts` DOES open here — the design-linter/license predicate covers
    // every apps/ file; the Rust pair is the assertion, not the bystanders.
    const { flags } = computePlan([], ["apps/server/desktop/src-tauri/src/trust.rs"]);
    expect(flags.rustApps).toBe(true);
    expect(flags.rustCore).toBe(false);
    const appLock = computePlan([], ["apps/client/desktop/src-tauri/Cargo.lock"]);
    expect(appLock.flags.rustApps).toBe(true);
    expect(appLock.flags.rustCore).toBe(false);
  });

  test("the builder image lights both Rust slices", () => {
    // The toolchain itself: rustup + Tauri system deps are IN the image
    // (docker/desktop-builder.Dockerfile), so an image change can break any
    // cargo run regardless of which tree it touches.
    const { flags } = computePlan([], ["docker/desktop-builder.Dockerfile"]);
    expect(flags.rustCore).toBe(true);
    expect(flags.rustApps).toBe(true);
    expect(flags.scripts).toBe(false);
  });

  test("a test.yml change itself runs EVERYTHING", () => {
    // The router cannot route its own change: gating the Rust jobs created a
    // class of PR (an edit HERE) whose own proof is exactly what a router
    // could mis-grey, so the self-reference answers all-true.
    const { flags, reason } = computePlan([], [".github/workflows/test.yml"]);
    expect(Object.values(flags).every(Boolean)).toBe(true);
    expect(reason).toContain("CI definition");
  });
});

describe("rustTouched", () => {
  test("fires per the Cargo dependency arrows and the toolchain image", () => {
    expect(rustTouched(["crates/desktop-core/src/lib.rs"])).toEqual({ core: true, apps: true });
    // Core first, app later: the early `{core:true, apps:true}` must not
    // depend on iteration order of the reverse spelling either.
    expect(rustTouched(["apps/client/desktop/src-tauri/src/cmd.rs", "crates/desktop-core/build.rs"])).toEqual({
      core: true,
      apps: true,
    });
    expect(rustTouched(["docker/desktop-builder.Dockerfile"])).toEqual({ core: true, apps: true });
    expect(rustTouched(["apps/server/desktop/src-tauri/Cargo.toml"])).toEqual({ core: false, apps: true });
  });

  test("stays quiet for everything else, desktop TS included", () => {
    // The trap this half exists for: the TS desktop packages live in the SAME
    // directories as the Rust crates. A React edit under apps/*/desktop must
    // not light the Rust jobs any more than a Rust edit lights `Test: desktop`.
    expect(rustTouched(["apps/server/desktop/ui/src/main.tsx"])).toEqual({ core: false, apps: false });
    expect(rustTouched(["docs/release-and-ci.md"])).toEqual({ core: false, apps: false });
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
