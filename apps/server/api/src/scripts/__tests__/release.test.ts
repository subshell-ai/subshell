import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_TARGETS, serverArtifactFileName } from "@internal/subshell-protocol";
import {
  type BuiltArtifact,
  digestFile,
  parseScope,
  publishArtifacts,
} from "@internal/subshell-protocol/release-artifacts";
import {
  type BuildAllResult,
  buildAll,
  buildArgs,
  buildTargets,
  resolveArtifactsDir,
  runEmbed,
  runRelease,
  SERVER_RELEASE_TRIPLES_ENV,
} from "../release.js";

// The server pipeline has NO parseScope wrapper (unlike the client's): main()
// calls the shared generalized parse with SERVER_TARGETS, so this suite pins
// THAT call shape — the same known set + env name the module wires in.
const ENV_NAME = SERVER_RELEASE_TRIPLES_ENV;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** The monorepo root, computed the way release.ts does (six levels above `__tests__`). */
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..", "..", "..", "..");

describe("buildArgs (always-bytecode, server entry, spec 2026-09-03 §5)", () => {
  test("every triple compiles with --bytecode AND an explicit --target, entry ./src/index.ts", () => {
    for (const triple of SERVER_TARGETS) {
      const args = buildArgs(triple, "/out");
      expect(args).toContain("--bytecode");
      expect(args).toContain("--minify");
      expect(args).toContain("./src/index.ts");
      expect(args).toContain(`--target=bun-${triple}`);
      expect(args).toContain(join("/out", serverArtifactFileName(triple)));
    }
  });
});

describe("buildTargets", () => {
  test("flat schedule: one entry per server triple, no host special case", () => {
    expect(buildTargets().map((t) => t.triple)).toEqual([...SERVER_TARGETS]);
  });

  test("scope narrows the schedule without reordering", () => {
    expect(buildTargets(["darwin-arm64", "linux-x64"]).map((t) => t.triple)).toEqual(["darwin-arm64", "linux-x64"]);
  });
});

describe("parseScope (shared generalized parse, pinned to SERVER_TARGETS)", () => {
  test("undefined → null (full set)", () => expect(parseScope(undefined, SERVER_TARGETS, ENV_NAME)).toBeNull());

  test("whitespace-separated subset passes through", () =>
    expect(parseScope(" linux-arm64\tdarwin-arm64 ", SERVER_TARGETS, ENV_NAME)).toEqual([
      "linux-arm64",
      "darwin-arm64",
    ]));

  test("unknown triple throws, naming this app's env var", () =>
    expect(() => parseScope("win32-x64", SERVER_TARGETS, ENV_NAME)).toThrow(
      new RegExp(`unknown target "win32-x64" in ${ENV_NAME}`),
    ));

  test("darwin-x64 is NOT a server target (client-only triple → refusal)", () =>
    expect(() => parseScope("darwin-x64", SERVER_TARGETS, ENV_NAME)).toThrow(/unknown target/i));
});

describe("buildAll", () => {
  let workDir = "";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "subshell-server-release-test-"));
  });

  /** runBuild stub: writes plausible bytes to the --outfile target, fails the named triple. */
  function stubRunBuild(failTriple?: string) {
    const calls: string[][] = [];
    const runBuild = async (args: string[]): Promise<number> => {
      calls.push(args);
      const outfile = args[args.indexOf("--outfile") + 1] as string;
      if (failTriple && outfile.endsWith(serverArtifactFileName(failTriple))) return 1;
      // The real main() mkdirs outDir before building; the stub mirrors that here.
      await mkdir(dirname(outfile), { recursive: true });
      await writeFile(outfile, `binary-bytes-for-${outfile}`);
      return 0;
    };
    return { calls, runBuild };
  }

  test("one failing target → {ok:false, failed:<triple>}; publish is a separate step runRelease skips", async () => {
    const outDir = join(workDir, "out-fail");
    const { runBuild } = stubRunBuild("linux-arm64");
    const result = await buildAll({ runBuild, outDir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.failed).toBe("linux-arm64");
    // (All-or-nothing is STRUCTURAL: buildAll never receives destDir, and
    // runRelease publishes only on ok:true — the result shape is the honest
    // assertion, exactly as in the client suite.)
  });

  test("all succeed → one artifact per triple with a sha256 digest matching the file bytes", async () => {
    const outDir = join(workDir, "out-ok");
    const { runBuild } = stubRunBuild();
    const result: BuildAllResult = await buildAll({ runBuild, outDir });
    if (!result.ok) throw new Error(`expected ok, got failure on ${result.failed}`);
    expect(result.artifacts.size).toBe(SERVER_TARGETS.length);
    for (const [triple, artifact] of result.artifacts) {
      expect(artifact.path).toBe(join(outDir, serverArtifactFileName(triple)));
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
    expect((SERVER_TARGETS as readonly string[]).includes(result.failed)).toBe(true);
  });
});

describe("runEmbed (preflight + generator, Task E)", () => {
  test("missing frontend dist refuses BEFORE the generator runs", async () => {
    let generatorCalls = 0;
    await expect(
      runEmbed({
        distIndexExists: () => false,
        runGenerator: async () => {
          generatorCalls++;
          return 0;
        },
      }),
    ).rejects.toThrow(/apps\/server\/web\/dist\/index\.html.*turbo build/s);
    expect(generatorCalls).toBe(0);
  });

  test("present dist runs the generator once; exit 0 passes", async () => {
    let generatorCalls = 0;
    await runEmbed({
      distIndexExists: () => true,
      runGenerator: async () => {
        generatorCalls++;
        return 0;
      },
    });
    expect(generatorCalls).toBe(1);
  });

  test("a failing generator aborts the release (nothing downstream runs)", async () => {
    await expect(runEmbed({ distIndexExists: () => true, runGenerator: async () => 1 })).rejects.toThrow(
      /embed step .* failed/s,
    );
  });
});

describe("runRelease (embed → build → publish, ALWAYS restore)", () => {
  let workDir = "";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "subshell-server-pipeline-test-"));
  });

  /** Full pipeline seams: real file-writing build stub + counted embed/publish/restore. */
  function pipelineDeps(outDir: string, opts: { failTriple?: string; distOk?: boolean } = {}) {
    const calls: string[][] = [];
    const published: Map<string, BuiltArtifact>[] = [];
    const counts = { restores: 0, embeds: 0 };
    const deps = {
      embed: {
        distIndexExists: () => opts.distOk ?? true,
        runGenerator: async () => {
          counts.embeds++;
          return 0;
        },
      },
      build: {
        runBuild: async (args: string[]) => {
          calls.push(args);
          const outfile = args[args.indexOf("--outfile") + 1] as string;
          if (opts.failTriple && outfile.endsWith(serverArtifactFileName(opts.failTriple))) return 1;
          await mkdir(dirname(outfile), { recursive: true });
          await writeFile(outfile, `binary-bytes-for-${outfile}`);
          return 0;
        },
        outDir,
      },
      publish: async (artifacts: Map<string, BuiltArtifact>, destDir: string) => {
        published.push(artifacts);
        expect(destDir).toBe(join(workDir, "dest"));
      },
      restoreEmbed: async () => {
        counts.restores++;
      },
      destDir: join(workDir, "dest"),
    };
    return { deps, calls, published, counts };
  }

  test("success: embed → all builds → publish, restore ALWAYS runs", async () => {
    const { deps, calls, published, counts } = pipelineDeps(join(workDir, "pipe-ok"));
    const result = await runRelease(deps, null);
    if (!result.ok) throw new Error(`expected ok, got failure on ${result.failed}`);
    expect(calls).toHaveLength(SERVER_TARGETS.length);
    expect(published).toHaveLength(1);
    expect(published[0]?.size).toBe(SERVER_TARGETS.length);
    expect(counts.embeds).toBe(1);
    expect(counts.restores).toBe(1);
  });

  test("mid-flight build failure: nothing published, restore STILL ran (the stub is never left generated)", async () => {
    const { deps, published, counts } = pipelineDeps(join(workDir, "pipe-fail"), { failTriple: "linux-arm64" });
    const result = await runRelease(deps, null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.failed).toBe("linux-arm64");
    expect(published).toHaveLength(0);
    expect(counts.restores).toBe(1);
  });

  test("embed refusal: no builds, no publish, restore still runs (a no-op on the untouched stub)", async () => {
    const { deps, calls, published, counts } = pipelineDeps(join(workDir, "pipe-nodist"), { distOk: false });
    await expect(runRelease(deps, null)).rejects.toThrow(/turbo build/);
    expect(calls).toHaveLength(0);
    expect(counts.embeds).toBe(0); // the preflight refused before the generator spawned
    expect(published).toHaveLength(0);
    expect(counts.restores).toBe(1);
  });
});

describe("resolveArtifactsDir (SUBSHELL_SERVER_RELEASE_DIR ?? <repo-root>/dist-server)", () => {
  const saved = process.env.SUBSHELL_SERVER_RELEASE_DIR;
  afterAll(() => {
    if (saved === undefined) delete process.env.SUBSHELL_SERVER_RELEASE_DIR;
    else process.env.SUBSHELL_SERVER_RELEASE_DIR = saved;
  });

  test("SUBSHELL_SERVER_RELEASE_DIR wins (resolved absolute)", () => {
    process.env.SUBSHELL_SERVER_RELEASE_DIR = "/tmp/p2e-artifacts";
    expect(resolveArtifactsDir()).toBe("/tmp/p2e-artifacts");
  });

  test("unset falls back to <repo-root>/dist-server", () => {
    delete process.env.SUBSHELL_SERVER_RELEASE_DIR;
    expect(resolveArtifactsDir()).toBe(join(REPO_ROOT, "dist-server"));
  });

  test("empty string counts as unset (every env ladder here treats '' as absent)", () => {
    process.env.SUBSHELL_SERVER_RELEASE_DIR = "";
    expect(resolveArtifactsDir()).toBe(join(REPO_ROOT, "dist-server"));
  });
});

describe("publish through the shared primitive (server artifact names, basename contract)", () => {
  test("the published set is EXACTLY subshell-server-cli-<triple> + .sha256 per target", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "subshell-server-publish-test-"));
    const artifacts = new Map<string, BuiltArtifact>();
    for (const triple of SERVER_TARGETS) {
      const path = join(workDir, "out", serverArtifactFileName(triple));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `bytes-${triple}`);
      artifacts.set(triple, { path, digest: await digestFile(path) });
    }
    const destDir = join(workDir, "dest");
    await publishArtifacts(artifacts, destDir);
    const names = (await readdir(destDir)).sort();
    // Literal on purpose: this is the one place the SHIPPED file names are
    // asserted without going through the naming function that produced them.
    expect(names).toEqual(
      SERVER_TARGETS.flatMap((t) => [`subshell-server-cli-${t}`, `subshell-server-cli-${t}.sha256`]).sort(),
    );
  });
});

describe("buildAll — signing hook (sign between build and digest)", () => {
  let workDir = "";
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "subshell-server-release-sign-test-"));
  });

  /** runBuild stub writing PLACEHOLDER bytes; the sign stub overwrites them. */
  function stub() {
    const signed: string[] = [];
    const runBuild = async (args: string[]): Promise<number> => {
      const outfile = args[args.indexOf("--outfile") + 1] as string;
      await mkdir(dirname(outfile), { recursive: true });
      await writeFile(outfile, `unsigned-${outfile}`);
      return 0;
    };
    const sign = async (path: string): Promise<boolean> => {
      signed.push(path);
      await writeFile(path, `signed-${path}`);
      return true;
    };
    return { signed, runBuild, sign };
  }

  test("sign runs once per artifact, and the digest describes the SIGNED bytes", async () => {
    const outDir = join(workDir, "out-sign-order");
    const { signed, runBuild, sign } = stub();
    const result = await buildAll({ runBuild, outDir, sign });
    if (!result.ok) throw new Error(`expected ok, got ${result.failed}`);
    expect(signed.length).toBe(SERVER_TARGETS.length);
    let i = 0;
    for (const [, artifact] of result.artifacts) {
      // keyed by index, not a path slice: artifact file names vary in
      // length, and a suffix cut can swallow a '/'.
      const expected = join(workDir, `expected-sign-${i++}`);
      await writeFile(expected, `signed-${artifact.path}`);
      expect(artifact.digest).toBe(await digestFile(expected));
    }
  });

  test("a refused signature fails the target like a failed build (nothing digests)", async () => {
    const outDir = join(workDir, "out-sign-refuse");
    const { runBuild } = stub();
    const result = await buildAll({ runBuild, outDir, sign: async () => false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.failed).toBe(SERVER_TARGETS[0]);
  });
});
