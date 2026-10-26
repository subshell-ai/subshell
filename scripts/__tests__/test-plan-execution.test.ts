import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePlan, ROOT, readWorkspaces } from "../ci-test-plan";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function execute(packages: string[], failure = 0) {
  const root = mkdtempSync(join(tmpdir(), "subshell-plan-execution-"));
  roots.push(root);
  const trace = join(root, "trace");
  writeFileSync(trace, "");
  const fake = join(root, "bunx");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "$COMMAND_TRACE"\nexit ${failure}\n`);
  chmodSync(fake, 0o755);
  const plan = { ...computePlan(readWorkspaces(), []), packages };
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    TEST_PLAN: JSON.stringify(plan),
    TEST_LANE: JSON.stringify({ packages, scripts: false }),
    COMMAND_TRACE: trace,
  };
  delete env.SHELLOPTS;
  delete env.BASHOPTS;
  const result = Bun.spawnSync([process.execPath, "scripts/run-test-plan.ts", "unit"], { cwd: ROOT, env });
  return { result, argv: readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) };
}

test("an empty unit selection never becomes an unfiltered Turbo invocation", () => {
  const { result, argv } = execute([]);
  expect(result.exitCode).toBe(0);
  expect(argv).toEqual([]);
});

test("unit execution passes only selected packages and disables retries", () => {
  const { result, argv } = execute(["@internal/assistant"]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(argv).toEqual(["turbo", "run", "test", "--filter=@internal/assistant", "--", "--retry=0"]);
});

test("a failing test command fails the orchestration process", () => {
  expect(execute(["@internal/assistant"], 7).result.exitCode).not.toBe(0);
});
