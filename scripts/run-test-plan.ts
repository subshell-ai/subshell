#!/usr/bin/env bun
/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This driver runs outside Turbo. */
import { ROOT, readWorkspaces, type TestPlan } from "./ci-test-plan";

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

export function runUnit(plan: TestPlan, packages = plan.packages, scripts = plan.scripts): void {
  const workspaces = readWorkspaces();
  const selected = packages.filter((name) => workspaces.find((p) => p.name === name)?.scripts.test);
  // Tests aren't cached. Full verification also rebuilds dependencies from this revision.
  turbo(["test"], selected, [...(plan.full ? ["--force"] : []), "--", "--retry=0"]);
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

export function runIntegration(plan: TestPlan): void {
  if (plan.smoke || plan.cli) {
    turbo(["build"], ["@internal/server", "@internal/node", "@internal/server-web", "@internal/node-web"]);
    if (plan.cli) run(["bun", "run", "test:cli"]);
    if (plan.smoke) run(["bash", "scripts/test-compiled-smoke.sh"]);
  }
  if (plan.e2e) {
    const args = plan.e2eFiles.map((f) => f.replace(/^e2e\//, ""));
    turbo(["test:e2e"], ["@internal/e2e"], ["--", ...(plan.full ? ["--retries=0"] : []), ...args]);
  }
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
      const lane = JSON.parse(process.env.TEST_LANE ?? "null") as { packages: string[]; scripts: boolean } | null;
      if (!lane) throw new Error("TEST_LANE is required");
      runUnit(plan, lane.packages, lane.scripts);
      break;
    }
    case "integration":
      runIntegration(plan);
      break;
    case "rust":
      runRust(plan);
      break;
    default:
      throw new Error("Expected checks, unit, integration, or rust");
  }
}
