#!/usr/bin/env bun
/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This driver runs outside Turbo. */
/** Shared change selection for PRs and local verification. No install or build is needed to plan. */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export interface Workspace {
  name: string;
  dir: string;
  dependencies: string[];
  scripts: Record<string, string>;
}
export interface TestPlan {
  full: boolean;
  reason: string;
  packages: string[];
  scripts: boolean;
  e2e: boolean;
  /** Empty means the complete browser suite; selected specs always include account setup. */
  e2eFiles: string[];
  smoke: boolean;
  cli: boolean;
  rust: string[];
  audit: boolean;
}
export const RUST_CRATES = ["crates/desktop-core", "apps/server/desktop/src-tauri", "apps/client/desktop/src-tauri"];

export function readWorkspaces(root = ROOT): Workspace[] {
  const manifest = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  const paths = new Set<string>();
  for (const pattern of manifest.workspaces as string[]) {
    for (const path of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) paths.add(path);
  }
  return [...paths].sort().map((path) => {
    const pkg = JSON.parse(readFileSync(`${root}/${path}`, "utf8"));
    return {
      name: pkg.name,
      dir: path.slice(0, -"/package.json".length),
      dependencies: Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      }),
      scripts: pkg.scripts ?? {},
    };
  });
}

export function fullPlan(workspaces: readonly Workspace[], reason: string): TestPlan {
  return {
    full: true,
    reason,
    packages: workspaces.map((p) => p.name).sort(),
    scripts: true,
    e2e: true,
    e2eFiles: [],
    smoke: true,
    cli: true,
    rust: [...RUST_CRATES],
    audit: true,
  };
}

const GLOBAL_INPUTS =
  /^(?:package\.json|bun\.lock|bunfig\.toml|turbo\.json|tsconfig[^/]*\.json|biome\.jsonc|patches\/|docker\/desktop-builder\.Dockerfile|scripts\/(?:ci-test-plan|test-changed|check-changed|run-test-plan)\.ts|scripts\/par-test\.sh|\.github\/(?:actions\/|workflows\/(?:test|lint|release|docs|website)\.yml))/;
const TEST_INPUT =
  /(?:^|\/)(?:__tests__|__snapshots__|test|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test-(?:setup|preload)\.[jt]s$|(?:^|\/)scripts\/test-run\.sh$|(?:^|\/)bunfig\.toml$|\.bun-test-timings\.json$/;

function documentation(path: string): boolean {
  return /\.md$/.test(path) || /^(?:docs\/|\.claude\/|\.agents\/)/.test(path);
}

/** Scripts read a few repository contracts outside their own directory. */
export function scriptsTouched(files: readonly string[]): boolean {
  return files.some(
    (f) =>
      /^packages\/subshell-protocol\/src\/__tests__\/fixtures\/release-signature\//.test(f) ||
      /^apps\/server\/api\/src\/services\/releases\.ts$/.test(f) ||
      /^apps\/(?:server|client)\/desktop\/src-tauri\/tauri\.conf\.json$/.test(f) ||
      ((f.startsWith("scripts/") || !TEST_INPUT.test(f)) &&
        (/^(?:scripts\/|\.github\/|\.changeset\/config\.json|install-[^/]+\.sh|proxmox-[^/]+\.sh|docker(?:\/|-entrypoint\.sh)|releases\.json)/.test(
          f,
        ) ||
          /(?:^|\/)(?:package\.json|Cargo\.toml|bun\.lock)$/.test(f) ||
          /(?:^|\/)(?:tokens\.css|theme\.ts)$/.test(f) ||
          /^(?:packages\/subshell-protocol\/|apps\/(?:server|client)\/desktop\/src\/scripts\/)/.test(f))),
  );
}

export function rustTouched(files: readonly string[]): string[] {
  if (
    files.some(
      (f) =>
        /^(?:crates\/desktop-core\/|native\/display-helper\/|docker\/desktop-builder\.Dockerfile|scripts\/(?:rust-check|macos-toolchain-preflight)\.sh)/.test(
          f,
        ) && !documentation(f),
    )
  )
    return [...RUST_CRATES];
  return RUST_CRATES.filter((dir) => files.some((f) => f.startsWith(`${dir}/`) && !documentation(f)));
}

export function computePlan(workspaces: readonly Workspace[], files: readonly string[]): TestPlan {
  if (files.some((f) => GLOBAL_INPUTS.test(f)))
    return fullPlan(workspaces, "shared toolchain or verification inputs changed");
  const direct = new Set<string>();
  const changedCode = new Set<string>();
  const owners = [...workspaces].sort((a, b) => b.dir.length - a.dir.length);
  for (const file of files) {
    if (documentation(file)) continue;
    // These build inputs are copied/read at runtime rather than imported through a workspace edge.
    if (/^(?:releases\.json|install-(?:server|client)\.sh)$/.test(file)) direct.add("@internal/website");
    if (/^scripts\/(?:cli-release-fetch|updater-manifest)\.ts$/.test(file)) {
      direct.add("@internal/desktop-server");
      direct.add("@internal/desktop-client");
    }
    if (/^(?:LICENSE|apps\/server\/LICENSE)$/.test(file)) direct.add("@internal/subshell-protocol");
    // Desktop JS tests also check Rust IPC/wire contracts and signing configuration.
    if (
      /^crates\/desktop-core\//.test(file) ||
      /^scripts\/macos-entitlements\.plist$/.test(file) ||
      /^apps\/(?:server|client)\/desktop\/src-tauri\/(?:tauri\.conf\.json|entitlements\.plist)$/.test(file)
    ) {
      direct.add("@internal/desktop-server");
      direct.add("@internal/desktop-client");
    }
    if (file === "apps/server/web/src/styles.css") direct.add("@internal/desktop-client");
    if (file === "apps/server/web/src/types/permissions.ts") direct.add("@internal/desktop-server");
    const owner = owners.find((p) => file.startsWith(`${p.dir}/`));
    if (owner) {
      direct.add(owner.name);
      // Rust runs the app's JS contract tests, but doesn't propagate as a JS dependency change.
      if (!TEST_INPUT.test(file) && !file.includes("/src-tauri/")) changedCode.add(owner.name);
      continue;
    }
    if (
      /^(?:scripts\/|\.github\/|\.changeset\/|crates\/|native\/|docker\/|brand\/)/.test(file) ||
      /^(?:[^/]+\.md|LICENSE|CLA\.md|\.gitignore|\.gitattributes|lefthook\.yml|\.bun-test-timings\.json|releases\.json|(?:install|proxmox)-[^/]+\.sh|docker-entrypoint\.sh)$/.test(
        file,
      )
    )
      continue;
    // A deleted/new workspace or an unmodelled root input must never silently disappear.
    return fullPlan(workspaces, `unclassified input: ${file}`);
  }
  const affected = new Set(changedCode);
  let growing = true;
  while (growing) {
    growing = false;
    for (const p of workspaces) {
      if (!affected.has(p.name) && p.dependencies.some((d) => affected.has(d))) {
        affected.add(p.name);
        growing = true;
      }
    }
  }
  const packages = [...new Set([...direct, ...affected])].sort();
  const e2eCode = affected.has("@internal/e2e");
  const e2eFiles = files.filter((f) => /^e2e\/tests\/.*\.spec\.ts$/.test(f));
  const e2e = e2eCode || e2eFiles.length > 0;
  // A fixture or Playwright configuration change affects all scenarios, even without an import edge.
  const wholeBrowserSuite =
    e2eCode || files.some((f) => f.startsWith("e2e/") && !documentation(f) && !e2eFiles.includes(f));
  const cli = files.some(
    (f) =>
      /^(?:scripts\/cli-e2e\/|apps\/node\/web\/|install-(?:server|client)\.sh|apps\/server\/api\/src\/commands\/|apps\/node\/agent\/src\/(?:cli|commands|configure|setup|enroll|service|update|backup))/.test(
        f,
      ) && !TEST_INPUT.test(f),
  );
  return {
    full: false,
    reason: packages.length ? "changed workspaces and their dependents" : "repository checks only",
    packages,
    scripts: scriptsTouched(files),
    e2e,
    e2eFiles: e2e && !wholeBrowserSuite ? [...new Set(["e2e/tests/01-setup-wizard.spec.ts", ...e2eFiles])].sort() : [],
    smoke:
      affected.has("@internal/server") ||
      files.some((f) => /^scripts\/(?:smoke-mcp-refusal|test-compiled-smoke)\.sh$/.test(f)),
    cli,
    rust: rustTouched(files),
    audit: files.some((f) => /(?:^|\/)(?:package\.json|bun\.lock)$/.test(f) || f.startsWith("scripts/dep-audit")),
  };
}

function git(args: string[], root: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

export function changedFiles(base: string, local = false, root = ROOT): string[] {
  if (!base) throw new Error("No base revision was provided");
  git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], root);
  // Include both sides of renames so moving a file between workspaces checks both consumers.
  const files = git(["diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`], root).split("\0");
  if (local) {
    files.push(...git(["diff", "--name-only", "--no-renames", "-z", "HEAD"], root).split("\0"));
    files.push(...git(["ls-files", "--others", "--exclude-standard", "-z"], root).split("\0"));
  }
  return [...new Set(files.filter(Boolean))].sort();
}

export function planChanges(base: string, local = false, full = false, root = ROOT): TestPlan {
  const workspaces = readWorkspaces(root);
  if (full) return fullPlan(workspaces, "full verification requested");
  try {
    return computePlan(workspaces, changedFiles(base, local, root));
  } catch (error) {
    return fullPlan(workspaces, `cannot establish changes: ${String(error)}`);
  }
}

/** Bound job setup cost to three unit jobs, regardless of the number of workspaces. */
export function unitLanes(plan: TestPlan, workspaces: readonly Workspace[]) {
  const tested = plan.packages.filter((name) => workspaces.find((p) => p.name === name)?.scripts.test);
  const groups = [
    {
      name: "server",
      packages: tested.filter((n) => n === "@internal/server" || n === "@internal/node"),
      scripts: false,
    },
    { name: "web", packages: tested.filter((n) => n === "@internal/server-web"), scripts: false },
    {
      name: "other",
      packages: tested.filter((n) => !["@internal/server", "@internal/node", "@internal/server-web"].includes(n)),
      scripts: plan.scripts,
    },
  ];
  return groups.filter((g) => g.packages.length || g.scripts);
}

if (import.meta.main) {
  const full = process.argv.includes("--full");
  const base = process.argv[2] ?? "origin/main";
  const plan = planChanges(base, process.argv.includes("--local"), full);
  console.log(JSON.stringify(plan, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    const output = {
      plan,
      units: unitLanes(plan, readWorkspaces()),
      integration: plan.e2e || plan.cli || plan.smoke,
      rust: plan.rust.length > 0,
    };
    for (const [key, value] of Object.entries(output))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${JSON.stringify(value)}\n`);
  }
}
