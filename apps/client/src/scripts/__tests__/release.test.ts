import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NODE_TARGETS } from "@internal/subshell-protocol";
import { digestFile } from "@internal/subshell-protocol/release-artifacts";
import { type BuildAllResult, buildAll, buildArgs, buildTargets, parseScope, resolveArtifactsDir } from "../release.js";

describe("buildArgs (always-bytecode, spec 2026-09-03 §5)", () => {
  test("every triple compiles with --bytecode AND an explicit --target", () => {
    for (const triple of NODE_TARGETS) {
      const args = buildArgs(triple, "/out");
      expect(args).toContain("--bytecode");
      expect(args).toContain(`--target=bun-${triple}`);
      expect(args).toContain(join("/out", `subshell-${triple}`));
    }
  });
});

describe("buildTargets", () => {
  test("flat schedule: one entry per served triple, no host special case", () => {
    expect(buildTargets().map((t) => t.triple)).toEqual([...NODE_TARGETS]);
  });

  test("scope narrows the schedule without reordering", () => {
    expect(buildTargets(["darwin-arm64", "linux-x64"]).map((t) => t.triple)).toEqual(["darwin-arm64", "linux-x64"]);
  });
});

// The client's parseScope is a thin wrapper over the protocol's generalized
// parseScope (plan 2 Task E DRY-up) — the parse, the shared refusal shape and
// the assertBunFloor/semverLt primitives are tested at the source
// (`packages/subshell-protocol/src/__tests__/release-artifacts.test.ts`);
// these cases pin THAT wrapper pins the right known set + env name.
describe("parseScope (wrapper over the shared parse, NODE_TARGETS)", () => {
  test("undefined → null (full set)", () => expect(parseScope(undefined)).toBeNull());

  test("whitespace-separated subset passes through", () =>
    expect(parseScope(" linux-arm64\tdarwin-x64 ")).toEqual(["linux-arm64", "darwin-x64"]));

  test("unknown triple throws, naming this app's env var", () =>
    expect(() => parseScope("win32-x64")).toThrow(/unknown target .* SUBSHELL_RELEASE_TRIPLES/));
});

describe("buildAll", () => {
  let workDir = "";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "subshell-release-test-"));
  });

  /** runBuild stub: writes plausible bytes to the --outfile target, fails the named triple. */
  function stubRunBuild(failTriple?: string) {
    const calls: string[][] = [];
    const runBuild = async (args: string[]): Promise<number> => {
      calls.push(args);
      const outfile = args[args.indexOf("--outfile") + 1] as string;
      if (failTriple && outfile.endsWith(`subshell-${failTriple}`)) return 1;
      // The real main() mkdirs outDir before building; the stub mirrors that here.
      await mkdir(dirname(outfile), { recursive: true });
      await writeFile(outfile, `binary-bytes-for-${outfile}`);
      return 0;
    };
    return { calls, runBuild };
  }

  test("one failing target → {ok:false, failed:<triple>}; publish is a separate step main() skips", async () => {
    const outDir = join(workDir, "out-fail");
    const { runBuild } = stubRunBuild("darwin-x64");
    const result = await buildAll({ runBuild, outDir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.failed).toBe("darwin-x64");
    // (All-or-nothing is STRUCTURAL: buildAll never receives destDir, and
    // main() calls publishArtifacts only on ok:true — a readdir here could
    // not fail, so the result shape is the honest assertion.)
  });

  test("all succeed → one artifact per triple with a sha256 digest matching the file bytes", async () => {
    const outDir = join(workDir, "out-ok");
    const { runBuild } = stubRunBuild();
    const result: BuildAllResult = await buildAll({ runBuild, outDir });
    if (!result.ok) throw new Error(`expected ok, got failure on ${result.failed}`);
    // Flat schedule: exactly one artifact per served triple — no host entry,
    // no dupes, regardless of the arch the suite runs on.
    expect(result.artifacts.size).toBe(NODE_TARGETS.length);
    for (const [triple, artifact] of result.artifacts) {
      expect(artifact.path).toBe(join(outDir, `subshell-${triple}`));
      expect(artifact.digest).toBe(await digestFile(artifact.path)); // production hasher, not a mirror
      expect(artifact.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("scope narrows the schedule and every spawned build carries the uniform argv", async () => {
    const outDir = join(workDir, "out-scope");
    const scope = ["darwin-arm64", "linux-x64"];
    const { calls, runBuild } = stubRunBuild();
    const result = await buildAll({ runBuild, outDir }, scope);
    if (!result.ok) throw new Error(`expected ok, got failure on ${result.failed}`);
    expect([...result.artifacts.keys()]).toEqual(scope);
    expect(calls).toHaveLength(scope.length);
    // Uniform argv (spec 2026-09-03 §5): every spawned build is bytecode + explicit target.
    for (const [i, args] of calls.entries()) {
      expect(args).toContain("--bytecode");
      expect(args).toContain(`--target=bun-${scope[i]}`);
    }
  });

  test("exit 0 but no output file counts as that target's failure (never publish a phantom)", async () => {
    const outDir = join(workDir, "out-phantom");
    const result = await buildAll({ runBuild: async () => 0, outDir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    // Whatever the first scheduled triple is, it is one of the served set.
    expect((NODE_TARGETS as readonly string[]).includes(result.failed)).toBe(true);
  });
});

describe("resolveArtifactsDir", () => {
  const saved = { ...process.env };
  afterAll(() => {
    process.env.SUBSHELL_NODE_ARTIFACTS_DIR = saved.SUBSHELL_NODE_ARTIFACTS_DIR;
    process.env.SUBSHELL_SERVER_DATA_DIR = saved.SUBSHELL_SERVER_DATA_DIR;
    process.env.DATABASE_PATH = saved.DATABASE_PATH;
  });

  test("SUBSHELL_NODE_ARTIFACTS_DIR wins outright", () => {
    process.env.SUBSHELL_NODE_ARTIFACTS_DIR = "/custom/artifacts";
    process.env.SUBSHELL_SERVER_DATA_DIR = "/should/not/be/used";
    expect(resolveArtifactsDir()).toBe("/custom/artifacts");
  });

  test("SUBSHELL_SERVER_DATA_DIR falls through to <it>/node-artifacts", () => {
    delete process.env.SUBSHELL_NODE_ARTIFACTS_DIR;
    process.env.SUBSHELL_SERVER_DATA_DIR = "/srv/subshell-data";
    expect(resolveArtifactsDir()).toBe("/srv/subshell-data/node-artifacts");
  });

  test("no env at all mirrors the backend default: DATABASE_PATH's directory + /node-artifacts", () => {
    delete process.env.SUBSHELL_NODE_ARTIFACTS_DIR;
    delete process.env.SUBSHELL_SERVER_DATA_DIR;
    process.env.DATABASE_PATH = "/srv/subshell/db/subshell.db";
    expect(resolveArtifactsDir()).toBe("/srv/subshell/db/node-artifacts");
  });

  test("non-file DATABASE_PATH (URI/memory/bare-name) falls back to ./data/node-artifacts like the backend", () => {
    delete process.env.SUBSHELL_NODE_ARTIFACTS_DIR;
    delete process.env.SUBSHELL_SERVER_DATA_DIR;
    for (const raw of ["file::memory:?cache=shared", ":memory:", "subshell.db"]) {
      process.env.DATABASE_PATH = raw;
      expect(resolveArtifactsDir()).toBe(join(process.cwd(), "data", "node-artifacts"));
    }
  });

  test("unset DATABASE_PATH defaults to ./data/subshell.db semantics", () => {
    delete process.env.SUBSHELL_NODE_ARTIFACTS_DIR;
    delete process.env.SUBSHELL_SERVER_DATA_DIR;
    delete process.env.DATABASE_PATH;
    expect(resolveArtifactsDir()).toBe(join(process.cwd(), "data", "node-artifacts"));
  });
});
