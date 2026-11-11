import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePlan, ROOT, readWorkspaces } from "../ci-test-plan";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function execute(
  packages: string[],
  failure = 0,
  lane: Record<string, unknown> = {},
  mode = "unit",
  planPatch: Record<string, unknown> = {},
  extraEnv: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "subshell-plan-execution-"));
  roots.push(root);
  const trace = join(root, "trace");
  writeFileSync(trace, "");
  const fake = join(root, "bunx");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "$COMMAND_TRACE"\nexit ${failure}\n`);
  chmodSync(fake, 0o755);
  const plan = { ...computePlan(readWorkspaces(), []), packages, ...planPatch };
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    TEST_PLAN: JSON.stringify(plan),
    TEST_LANE: JSON.stringify({ packages, scripts: false, ...lane }),
    ...extraEnv,
    COMMAND_TRACE: trace,
  };
  delete env.SHELLOPTS;
  delete env.BASHOPTS;
  const result = Bun.spawnSync([process.execPath, "scripts/run-test-plan.ts", mode], { cwd: ROOT, env });
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

test("server tests build their frontend before booting a real server", () => {
  const { result, argv } = execute(["@internal/server"]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(argv).toEqual([
    "turbo",
    "run",
    "build",
    "--filter=@internal/server-web",
    "turbo",
    "run",
    "test",
    "--filter=@internal/server",
    "--",
    "--retry=0",
  ]);
});

test("a sharded lane asks bun for its half with the committed timings", () => {
  const { result, argv } = execute(["@internal/server"], 0, { shard: "1/2" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(argv).toEqual([
    "turbo",
    "run",
    "build",
    "--filter=@internal/server-web",
    "turbo",
    "run",
    "test",
    "--filter=@internal/server",
    "--",
    "--retry=0",
    "--shard=1/2",
    `--timings=${join(ROOT, ".bun-test-timings.json")}`,
  ]);
});

test("a browser shard passes setup plus only its own spec files", () => {
  const { result, argv } = execute([], 0, {}, "e2e", { e2e: true, e2eFiles: [], full: true }, { TEST_SHARD: "2/2" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(argv.slice(0, 6)).toEqual(["turbo", "run", "test:e2e", "--filter=@internal/e2e", "--", "--retries=0"]);
  expect(argv).toContain("tests/00-smoke.spec.ts");
  expect(argv).toContain("tests/01-setup-wizard.spec.ts");
  expect(argv).toContain("tests/12-nodes.spec.ts");
  expect(argv).not.toContain("tests/04-presets.spec.ts");
});
