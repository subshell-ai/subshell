#!/usr/bin/env bun
/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This driver runs outside Turbo. */
import { join } from "node:path";
import { ROOT, readWorkspaces, type TestPlan } from "./ci-test-plan";
import { E2E_SHARDS, e2eShardFiles } from "./e2e-shard";

/** Spawn argv directly: package names and changed paths must never become shell code. */
export function run(command: string[], cwd = ROOT): void {
  console.log(`> ${command.join(" ")}`);
  const env = { ...process.env };
  delete env.SHELLOPTS;
  delete env.BASHOPTS;
  const child = Bun.spawnSync(command, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (child.exitCode !== 0) throw new Error(`${command[0]} exited ${child.exitCode}`);
}

export function turbo(tasks: string[], packages: string[], extra: string[] = []): void {
  // No filters means ALL packages to Turbo, so an empty selection must stop here.
  if (!packages.length) return;
  run(["bunx", "turbo", "run", ...tasks, ...packages.map((name) => `--filter=${name}`), ...extra]);
}

export function runUnit(plan: TestPlan, packages = plan.packages, scripts = plan.scripts, shard?: string): void {
  const workspaces = readWorkspaces();
  const selected = packages.filter((name) => workspaces.find((p) => p.name === name)?.scripts.test);
  // The cross-subshell tests boot a real server, which serves the built SPA.
  if (selected.includes("@internal/server")) turbo(["build"], ["@internal/server-web"]);
  // Tests aren't cached. Full verification also rebuilds dependencies from this revision.
  const extra = [...(plan.full ? ["--force"] : []), "--", "--retry=0"];
  // The committed timings file is what makes Bun split `--shard` by measured
  // duration instead of file count.
  if (shard) extra.push(`--shard=${shard}`, `--timings=${join(ROOT, ".bun-test-timings.json")}`);
  turbo(["test"], selected, extra);
  if (scripts) {
    turbo(["build"], ["@internal/subshell-protocol"]);
    run(["bun", "run", "test:scripts"]);
  }
}

export function runChecks(plan: TestPlan): void {
  // Build the selected consumers too: a type check alone misses Metro/browser bundling failures.
  turbo(["build", "verify-types", "lint:check"], plan.packages, plan.full ? ["--force"] : []);
  if (plan.packages.includes("@internal/docs")) run(["bun", "run", "--cwd", "apps/docs", "verify:export"]);
  run(["bunx", "biome", "check", "scripts", "package.json", "turbo.json"]);
  for (const check of ["lint:packages", "lint:lockfile", "lint:licenses", "lint:design", "lint:prose"])
    run(["bun", "run", check]);
  if (plan.audit) run(["bun", "run", "audit:deps"]);
}

export function runCli(plan: TestPlan): void {
  if (!(plan.smoke || plan.cli)) return;
  turbo(["build"], ["@internal/server", "@internal/node", "@internal/server-web", "@internal/node-web"]);
  if (plan.cli) run(["bun", "run", "test:cli"]);
  if (plan.smoke) run(["bash", "scripts/test-compiled-smoke.sh"]);
}

export function runE2e(plan: TestPlan, shard?: string): void {
  if (!plan.e2e) return;
  const retries = plan.full ? ["--retries=0"] : [];
  const selected = plan.e2eFiles.map((f) => f.replace(/^e2e\//, ""));
  let files = selected;
  if (shard) {
    const [index, count] = shard.split("/").map(Number);
    if (count !== E2E_SHARDS) throw new Error(`unknown e2e shard '${shard}' (expected i/${E2E_SHARDS})`);
    files = e2eShardFiles(selected, index);
    if (!files.length) {
      console.log(`e2e shard ${shard}: no selected files`);
      return;
    }
  }
  turbo(["test:e2e"], ["@internal/e2e"], ["--", ...retries, ...files]);
}

export function runIntegration(plan: TestPlan): void {
  runCli(plan);
  runE2e(plan);
}

export function runRust(plan: TestPlan): void {
  if (plan.rust.length) run(["bash", "scripts/rust-check.sh", ...plan.rust]);
}

if (import.meta.main) {
  const plan = JSON.parse(process.env.TEST_PLAN ?? "null") as TestPlan | null;
  if (!plan) throw new Error("TEST_PLAN is required; use test:changed for local runs");
  switch (process.argv[2]) {
    case "checks":
      runChecks(plan);
      break;
    case "unit": {
      const lane = JSON.parse(process.env.TEST_LANE ?? "null") as {
        packages: string[];
        scripts: boolean;
        shard?: string;
      } | null;
      if (!lane) throw new Error("TEST_LANE is required");
      runUnit(plan, lane.packages, lane.scripts, lane.shard);
      break;
    }
    case "cli":
      runCli(plan);
      break;
    case "e2e":
      runE2e(plan, process.env.TEST_SHARD);
      break;
    case "integration":
      runIntegration(plan);
      break;
    case "rust":
      runRust(plan);
      break;
    default:
      throw new Error("Expected checks, unit, integration, cli, e2e, or rust");
  }
}
