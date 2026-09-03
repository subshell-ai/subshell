import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { digestFile } from "@internal/subshell-protocol";
import {
  type BuildAllResult,
  buildAll,
  buildArgs,
  buildTargets,
  CROSS_TARGETS,
  hostTriple,
  resolveArtifactsDir,
} from "../release.js";

describe("hostTriple", () => {
  test("maps the four supported platform/arch combos to their triples", () => {
    expect(hostTriple("linux", "x64")).toBe("linux-x64");
    expect(hostTriple("linux", "arm64")).toBe("linux-arm64");
    expect(hostTriple("darwin", "x64")).toBe("darwin-x64");
    expect(hostTriple("darwin", "arm64")).toBe("darwin-arm64");
  });

  test("unknown platform or arch → null (no host artifact for it)", () => {
    expect(hostTriple("win32", "x64")).toBeNull();
    expect(hostTriple("freebsd", "arm64")).toBeNull();
    expect(hostTriple("linux", "riscv64")).toBeNull();
  });

  test("no-arg form reads the real process (any supported host yields a triple)", () => {
    expect(hostTriple()).toBe(hostTriple(process.platform, process.arch));
    // No arch literal pinned: pre-push runs `test` on arm64 hosts too.
  });
});

describe("buildTargets", () => {
  test("a duplicating host (linux-x64) yields 4 entries, one per triple, host wins its triple", () => {
    const targets = buildTargets("linux-x64");
    expect(targets).toHaveLength(4);
    expect(new Set(targets.map((t) => t.triple)).size).toBe(4);
    const host = targets.filter((t) => t.isHost);
    expect(host).toHaveLength(1);
    expect(host[0]?.triple).toBe("linux-x64");
    // The HOST entry is the only one that gets --bytecode; cross builds never do (spec risk #9).
    for (const t of targets) expect(t.isHost).toBe(t.triple === "linux-x64");
    // Every cross triple is still present exactly once.
    for (const triple of CROSS_TARGETS) expect(targets.filter((t) => t.triple === triple)).toHaveLength(1);
  });

  test("a foreign host triple is force-added alongside the 4 cross targets (5 unique)", () => {
    const targets = buildTargets("win32-x64");
    expect(targets).toHaveLength(5);
    expect(new Set(targets.map((t) => t.triple)).size).toBe(5);
    const host = targets.filter((t) => t.isHost);
    expect(host).toHaveLength(1);
    expect(host[0]?.triple).toBe("win32-x64");
  });

  test("null host → the 4 cross targets only, none flagged host", () => {
    const targets = buildTargets(null);
    expect(targets).toHaveLength(4);
    expect(targets.every((t) => !t.isHost)).toBe(true);
  });
});

describe("buildArgs", () => {
  test("cross build: --compile --minify, NO --bytecode, explicit --target=bun-<triple>", () => {
    const args = buildArgs("darwin-arm64", false, "/tmp/out");
    expect(args.slice(0, 2)).toEqual(["build", "--compile"]);
    expect(args).not.toContain("--bytecode");
    expect(args).toContain("--minify");
    expect(args).toContain("--target=bun-darwin-arm64");
    expect(args).toContain("./src/main.ts");
    expect(args.slice(-2)).toEqual(["--outfile", join("/tmp/out", "subshell-darwin-arm64")]);
  });

  test("host build: adds --bytecode and omits --target entirely", () => {
    const args = buildArgs("linux-x64", true, "/tmp/out");
    expect(args.slice(0, 3)).toEqual(["build", "--compile", "--bytecode"]);
    expect(args.some((a) => a.startsWith("--target"))).toBe(false);
    expect(args.slice(-2)).toEqual(["--outfile", join("/tmp/out", "subshell-linux-x64")]);
  });
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
    // One artifact per triple: every supported host duplicates one cross
    // target (the host build wins its triple), so 4 on all four arches.
    expect(result.artifacts.size).toBe(4);
    for (const [triple, artifact] of result.artifacts) {
      expect(artifact.path).toBe(join(outDir, `subshell-${triple}`));
      expect(artifact.digest).toBe(await digestFile(artifact.path)); // production hasher, not a mirror
      expect(artifact.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("exit 0 but no output file counts as that target's failure (never publish a phantom)", async () => {
    const outDir = join(workDir, "out-phantom");
    const result = await buildAll({ runBuild: async () => 0, outDir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    // Whatever the host triple is, it is one of the four served triples.
    expect((CROSS_TARGETS as readonly string[]).includes(result.failed)).toBe(true);
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
