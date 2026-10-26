#!/usr/bin/env bun
/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This driver runs outside Turbo. */
import { planChanges } from "./ci-test-plan";
import { run, turbo } from "./run-test-plan";

const plan = planChanges(process.env.SUBSHELL_CHECK_BASE ?? "origin/main", true);
console.log(`Checking ${plan.packages.length} affected workspaces: ${plan.reason}`);
switch (process.argv[2]) {
  case "types":
    turbo(["verify-types"], plan.packages);
    break;
  case "lint":
    turbo(["lint:check"], plan.packages);
    run(["bunx", "biome", "check", "scripts", "package.json", "turbo.json"]);
    break;
  default:
    throw new Error("Expected types or lint");
}
