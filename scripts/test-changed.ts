#!/usr/bin/env bun
import { planChanges } from "./ci-test-plan";
import { runChecks, runIntegration, runRust, runUnit } from "./run-test-plan";

const args = process.argv.slice(2);
const known = new Set(["--full", "--plan", "--checks", "--unit", "--base"]);
for (let i = 0; i < args.length; i++) {
  if (!known.has(args[i] ?? "")) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] === "--base" && !args[++i]) throw new Error("--base needs a git ref");
}
if (args.includes("--full") && args.includes("--unit"))
  throw new Error("Full verification cannot omit integration or native tests");
const baseIndex = args.indexOf("--base");
const plan = planChanges(
  baseIndex < 0 ? "origin/main" : (args[baseIndex + 1] ?? "origin/main"),
  true,
  args.includes("--full"),
);
console.log(JSON.stringify(plan, null, 2));
if (!args.includes("--plan")) {
  if (args.includes("--checks") || plan.full) runChecks(plan);
  runUnit(plan);
  if (!args.includes("--unit")) {
    runIntegration(plan);
    runRust(plan);
  }
}
