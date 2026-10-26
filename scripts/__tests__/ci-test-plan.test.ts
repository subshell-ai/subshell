import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedFiles,
  computePlan,
  fullPlan,
  planChanges,
  ROOT,
  RUST_CRATES,
  readWorkspaces,
  unitLanes,
  type Workspace,
} from "../ci-test-plan";

const workspaces = readWorkspaces();
const plan = (files: string[]) => computePlan(workspaces, files);

describe("change selection", () => {
  test("internal prose and changesets don't start product suites", () => {
    const selected = plan(["AGENTS.md", "docs/testing.md", "apps/server/web/AGENTS.md", ".changeset/fix.md"]);
    expect(selected.packages).toEqual([]);
    expect(selected.scripts || selected.e2e || selected.smoke || selected.cli).toBe(false);
    expect(selected.rust).toEqual([]);
  });

  test("docs and node-web are ordinary workspaces, not unknown-package full runs", () => {
    expect(plan(["apps/docs/content/docs/index.mdx"]).packages).toEqual(["@internal/docs"]);
    const nodeWeb = plan(["apps/node/web/src/main.tsx"]);
    expect(nodeWeb.full).toBe(false);
    expect(nodeWeb.packages).toContain("@internal/node-web");
    expect(nodeWeb.rust).toEqual([]);
  });

  test("production changes reach transitive consumers, including browser and Metro builds", () => {
    const selected = plan(["packages/subshell-protocol/src/frames.ts"]);
    for (const name of [
      "@internal/subshell-protocol",
      "@internal/server",
      "@internal/node",
      "@internal/server-web",
      "@internal/mobile",
      "@internal/e2e",
    ])
      expect(selected.packages).toContain(name);
    expect(selected.e2e).toBe(true);
    expect(selected.smoke).toBe(true);
  });

  test("a unit-test-only edit stays in its owning package", () => {
    const selected = plan(["packages/subshell-protocol/src/__tests__/frames.test.ts"]);
    expect(selected.packages).toEqual(["@internal/subshell-protocol"]);
    expect(selected.e2e || selected.smoke || selected.cli).toBe(false);
    const web = plan(["apps/server/web/src/components/__tests__/x.test.tsx"]);
    expect(web.packages).toEqual(["@internal/server-web"]);
    expect(web.scripts).toBe(false);
    expect(plan(["apps/server/api/src/test-preload.ts"]).packages).toEqual(["@internal/server"]);
    expect(plan(["apps/server/api/scripts/test-run.sh"]).e2e).toBe(false);
  });

  test("a web edit doesn't run the website, scripts, or Rust", () => {
    const selected = plan(["apps/server/web/src/components/example.tsx"]);
    expect(selected.packages).not.toContain("@internal/website");
    expect(selected.scripts).toBe(false);
    expect(selected.rust).toEqual([]);
    expect(selected.e2e).toBe(true);
  });

  test("browser-only specs keep account setup and fixtures widen to every scenario", () => {
    expect(plan(["e2e/tests/04-presets.spec.ts"]).e2eFiles).toEqual([
      "e2e/tests/01-setup-wizard.spec.ts",
      "e2e/tests/04-presets.spec.ts",
    ]);
    expect(plan(["e2e/helpers.ts"]).e2eFiles).toEqual([]);
    expect(plan(["e2e/helpers.ts"]).e2e).toBe(true);
    expect(plan(["e2e/__tests__/capture-file-paths.test.ts"]).e2e).toBe(false);
  });

  test("Rust follows path dependencies but an app edit doesn't test its sibling", () => {
    expect(plan(["apps/client/desktop/src-tauri/src/lib.rs"]).rust).toEqual(["apps/client/desktop/src-tauri"]);
    expect(plan(["apps/client/desktop/src-tauri/src/lib.rs"]).packages).toEqual(["@internal/desktop-client"]);
    expect(plan(["crates/desktop-core/src/lib.rs"]).rust).toEqual(RUST_CRATES);
    expect(plan(["crates/desktop-core/src/lib.rs"]).packages).toEqual([
      "@internal/desktop-client",
      "@internal/desktop-server",
    ]);
    expect(plan(["native/display-helper/Consent.swift"]).rust).toEqual(RUST_CRATES);
    expect(plan(["apps/client/desktop/ui/src/main.tsx"]).rust).toEqual([]);
  });

  test("the real node used by browser fixtures stays in the dependency graph", () => {
    expect(plan(["apps/node/agent/src/main.ts"]).e2e).toBe(true);
    expect(plan(["apps/node/web/src/main.tsx"]).cli).toBe(true);
  });

  test("copied site and release inputs select their consumers", () => {
    expect(plan(["releases.json"]).packages).toContain("@internal/website");
    expect(plan(["install-server.sh"]).cli).toBe(true);
    expect(plan(["install-client.sh"]).packages).toContain("@internal/website");
    expect(plan(["scripts/cli-release-fetch.ts"]).packages).toEqual([
      "@internal/desktop-client",
      "@internal/desktop-server",
    ]);
    expect(plan(["scripts/test-compiled-smoke.sh"]).smoke).toBe(true);
    expect(plan(["scripts/macos-entitlements.plist"]).packages).toEqual([
      "@internal/desktop-client",
      "@internal/desktop-server",
    ]);
    expect(plan(["apps/server/web/src/types/permissions.ts"]).packages).toContain("@internal/desktop-server");
    expect(plan(["apps/server/api/src/modules/updates/releases.ts"]).scripts).toBe(true);
    expect(
      plan(["packages/subshell-protocol/src/__tests__/fixtures/release-signature/publisher-pubkey.txt"]).scripts,
    ).toBe(true);
  });

  test("new workspaces route automatically and dependency cycles terminate", () => {
    const graph: Workspace[] = [
      { name: "new", dir: "packages/new", dependencies: ["consumer"], scripts: { test: "bun test" } },
      { name: "consumer", dir: "apps/new", dependencies: ["new"], scripts: { test: "bun test" } },
    ];
    expect(computePlan(graph, ["packages/new/index.ts"]).packages).toEqual(["consumer", "new"]);
  });

  test("unknown/deleted inputs, unavailable history, and verification changes run everything", () => {
    for (const file of [
      "unknown.config",
      "packages/removed/index.ts",
      "bun.lock",
      ".github/workflows/test.yml",
      ".github/workflows/release.yml",
      "scripts/ci-test-plan.ts",
      ".github/actions/setup-ci/action.yml",
    ]) {
      expect(plan([file]).full).toBe(true);
    }
    expect(planChanges("nonexistent-test-base-123456").full).toBe(true);
    expect(planChanges("").full).toBe(true);
  });

  test("full verification reaches every registered test script once and every extra tier", () => {
    const selected = fullPlan(workspaces, "release");
    const lanes = unitLanes(selected, workspaces);
    const names = lanes.flatMap((l) => l.packages).sort();
    expect(names).toEqual(
      workspaces
        .filter((w) => w.scripts.test)
        .map((w) => w.name)
        .sort(),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(lanes.filter((l) => l.scripts)).toHaveLength(1);
    expect(selected.e2e && selected.cli && selected.smoke && selected.audit).toBe(true);
    expect(selected.rust).toEqual(RUST_CRATES);
    expect(unitLanes(plan([]), workspaces)).toEqual([]);
  });
});

const root = mkdtempSync(join(tmpdir(), "subshell-change-plan-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("git selection includes both rename paths, staged/unstaged work, and untracked files", () => {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  git("init", "-q");
  writeFileSync(join(root, "old.ts"), "original");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "base");
  git("mv", "old.ts", "moved.ts");
  writeFileSync(join(root, "moved.ts"), "edited");
  writeFileSync(join(root, "new.ts"), "new");
  expect(changedFiles("HEAD", true, root)).toEqual(["moved.ts", "new.ts", "old.ts"]);
  expect(changedFiles("HEAD", false, root)).toEqual([]);
});

test("the CLI writes machine-readable outputs and plans without dependencies", () => {
  const output = join(root, "outputs");
  const result = Bun.spawnSync([process.execPath, "scripts/ci-test-plan.ts", "--full"], {
    cwd: ROOT,
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout.toString());
  expect(parsed.full).toBe(true);
  const lines = readFileSync(output, "utf8").trim().split("\n");
  expect(lines.map((line: string) => line.slice(0, line.indexOf("=")))).toEqual([
    "plan",
    "units",
    "integration",
    "rust",
  ]);
});
