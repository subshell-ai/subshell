/**
 * `bun run compile:release` — the operator-facing release pipeline for the
 * `subshell-server` binary (plan 2, Task E; spec 2026-09-03 §3–§5). Cloned
 * from the agent's proven shape: builds every SERVER_TARGETS triple into
 * `apps/server/api/dist/release/` with `--bytecode` (uniform, floor 1.4.0
 * asserted), digests each via the shared `digestFile`, then publishes
 * atomically (tmp + rename + `.sha256` sidecar) into
 * `SUBSHELL_SERVER_RELEASE_DIR` (default `<repo-root>/dist-server`).
 *
 * The EMBED step is this pipeline's one addition over the agent's: the
 * compiled binary serves the SPA from `src/generated/embedded-web.ts`, so
 * BEFORE any build the frontend dist is pref-lighted (must exist — the agent
 * workspace-build preflight precedent) and the generator runs; the TRACKED
 * stub is then ALWAYS restored with `git checkout` — in a `finally`, so a
 * mid-flight build failure still leaves the working tree clean (the embedded
 * bytes are release noise, never a commit).
 *
 * Deliberately SEPARATE from `compile` (host-only dev build): cross builds
 * download target runtimes over the network on first use. This file lives
 * outside the runtime import graph, so the compiled binary never sees it;
 * tests import the pure exports only (the CLI entry is guarded by
 * `import.meta.main`).
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_TARGETS, serverArtifactFileName } from "@internal/subshell-protocol";
import {
  assertBunFloor,
  type BuiltArtifact,
  digestFile,
  parseScope,
  publishArtifacts,
  runSignHook,
} from "@internal/subshell-protocol/release-artifacts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/server/api` — the cwd every `bun build`/embed/restore invocation runs in. */
const SERVER_DIR = resolve(SCRIPT_DIR, "..", "..");
/** The monorepo root — the default publish dir and the web-dist preflight home. */
const REPO_ROOT = resolve(SERVER_DIR, "..", "..", "..");

/** The scope env var main() parses — exported so tests pin the SAME call shape (and refusal text). */
export const SERVER_RELEASE_TRIPLES_ENV = "SUBSHELL_SERVER_RELEASE_TRIPLES";

/** One entry of the build schedule. */
export interface BuildTarget {
  /** Platform triple this artifact is published under. */
  triple: string;
}

/**
 * The build schedule: one artifact per SERVER_TARGETS entry (or per `scope`
 * entry — `SUBSHELL_SERVER_RELEASE_TRIPLES` narrows it, CI sharding). Every
 * target ships `--bytecode` (the client pipeline's rule, spec 2026-09-03 §5);
 * the floor is asserted in main().
 * @param scope - triples to build; null/undefined = the full SERVER_TARGETS set
 */
export function buildTargets(scope: readonly string[] | null = null): BuildTarget[] {
  const set = scope ?? [...SERVER_TARGETS];
  return set.map((triple) => ({ triple }));
}

/**
 * `bun build` argv for one target (spawned with cwd `apps/server/api`).
 * Uniform: `--compile --bytecode --minify --target=bun-<triple>` — the entry
 * stays `./src/index.ts`, the byte-identical boot path of the plain `tsc`
 * dist (plan 2 Global Constraints).
 * @param triple - platform triple to build
 * @param outDir - directory for the `subshell-server-cli-<triple>` output file
 */
export function buildArgs(triple: string, outDir: string): string[] {
  return [
    "build",
    "--compile",
    "--bytecode",
    "--minify",
    "./src/index.ts",
    `--target=bun-${triple}`,
    "--outfile",
    join(outDir, serverArtifactFileName(triple)),
  ];
}

/** Injectable build runner for tests (a real spawn in `main`). */
export interface ReleaseDeps {
  /** Runs one `bun build` argv (relative to `apps/server/api`); resolves with its exit code. */
  runBuild: (args: string[]) => Promise<number>;
  /** Directory the compiled binaries are written to. */
  outDir: string;
  /**
   * Post-build signing hook (default: {@link runSignHook}, which honors
   * `SUBSHELL_RELEASE_SIGN_CMD`). Runs BEFORE the digest, so sidecars always
   * describe the signed bytes; a false result fails the target.
   */
  sign?: (path: string) => Promise<boolean>;
}

/** Result of {@link buildAll} — either the full artifact set or the first triple that failed. */
export type BuildAllResult = { ok: true; artifacts: Map<string, BuiltArtifact> } | { ok: false; failed: string };

/**
 * Builds every target (full set, or `scope`) and digests it. NEVER publishes
 * — {@link runRelease} publishes only on `ok:true`, so a failed target
 * publishes nothing (all-or-nothing, design §1).
 * @param deps - injected runner + output directory
 * @param scope - triples to build; null/undefined = the full served set
 */
export async function buildAll(deps: ReleaseDeps, scope?: string[] | null): Promise<BuildAllResult> {
  const artifacts = new Map<string, BuiltArtifact>();
  for (const target of buildTargets(scope ?? null)) {
    const code = await deps.runBuild(buildArgs(target.triple, deps.outDir));
    if (code !== 0) return { ok: false, failed: target.triple };
    const path = join(deps.outDir, serverArtifactFileName(target.triple));
    // Sign (when configured) BEFORE digesting — the sidecar must match the
    // bytes that get published, and a refused signature fails this target.
    if (!(await (deps.sign ?? ((p: string) => runSignHook(p)))(path))) {
      return { ok: false, failed: target.triple };
    }
    try {
      artifacts.set(target.triple, { path, digest: await digestFile(path) });
    } catch {
      // Exit 0 without an output file is that target's failure — publishing a
      // stale or phantom artifact is worse than publishing nothing.
      return { ok: false, failed: target.triple };
    }
  }
  return { ok: true, artifacts };
}

/** Injectable SPA-embed step (the generator spawn is behind `runGenerator`). */
export interface EmbedDeps {
  /** True when `apps/server/web/dist/index.html` exists (fake fs in tests). */
  distIndexExists: () => boolean;
  /** Runs the embed generator (`bun run src/scripts/embed-web.ts`); its exit code. */
  runGenerator: () => Promise<number>;
}

/**
 * The SPA embed step, BEFORE any compile: the emitted `embedded-web.ts` is
 * what makes the binary self-serving, so a missing frontend dist refuses the
 * release (the agent's workspace-build preflight wording) rather than
 * shipping a binary whose pages 500, and a failing generator aborts too.
 * @param deps - fs seam + generator seam
 */
export async function runEmbed(deps: EmbedDeps): Promise<void> {
  if (!deps.distIndexExists()) {
    throw new Error(
      "the built SPA is missing (apps/server/web/dist/index.html) — " +
        "run `turbo build` first from the repo root (the compiled server embeds it).",
    );
  }
  const code = await deps.runGenerator();
  if (code !== 0) {
    throw new Error("the embed step (scripts/embed-web.ts) failed (nothing built or published)");
  }
}

/** Full pipeline seams — every side effect the real `main` spawns. */
export interface ReleasePipelineDeps {
  /** The SPA embed step (preflight + generator). */
  embed: EmbedDeps;
  /** Compile runner + staging dir for {@link buildAll}. */
  build: ReleaseDeps;
  /** Publishes a complete artifact set (production `publishArtifacts` in main). */
  publish: (artifacts: Map<string, BuiltArtifact>, destDir: string) => Promise<void>;
  /** Restores the tracked `embedded-web.ts` stub (`git checkout`, main); ALWAYS runs. */
  restoreEmbed: () => Promise<void>;
  /** Publish destination. */
  destDir: string;
}

/**
 * One full pipeline pass: embed → build all → publish (only on a complete
 * build). The stub restore runs in a `finally`, so the working tree is clean
 * even when the embed refuses or a mid-schedule build fails — the embedded
 * bytes are release noise, never a commit.
 * @param deps - pipeline seams
 * @param scope - triples to build; null = the full SERVER_TARGETS set
 */
export async function runRelease(deps: ReleasePipelineDeps, scope: string[] | null): Promise<BuildAllResult> {
  try {
    await runEmbed(deps.embed);
    const result = await buildAll(deps.build, scope);
    if (result.ok) await deps.publish(result.artifacts, deps.destDir);
    return result;
  } finally {
    await deps.restoreEmbed();
  }
}

/**
 * The publish destination: `SUBSHELL_SERVER_RELEASE_DIR`, else
 * `<repo-root>/dist-server` — a local drop dir the operator scp/deploys;
 * unlike the client there is no serve-from-data-dir ladder to agree on.
 */
export function resolveArtifactsDir(): string {
  const override = process.env.SUBSHELL_SERVER_RELEASE_DIR;
  return override ? resolve(override) : join(REPO_ROOT, "dist-server");
}

/** Runs one `bun` subcommand argv in `apps/server/api` with output streamed to this console. */
async function runBun(args: string[]): Promise<number> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: SERVER_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

/**
 * Restores the tracked `embedded-web.ts` stub after the builds consumed the
 * generated one (`git checkout` from `apps/server/api`). A failure here is loud
 * but non-fatal — the artifacts are published; the tree just needs one
 * manual command before the next commit.
 */
async function restoreStub(): Promise<void> {
  const child = Bun.spawn(["git", "checkout", "--", join("src", "generated", "embedded-web.ts")], {
    cwd: SERVER_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) {
    process.stderr.write(
      "compile:release: could not restore the embedded-web stub. Run " +
        "`git checkout -- apps/server/api/src/generated/embedded-web.ts` by hand.\n",
    );
  }
}

/** CLI entry: floor + scope → embed → build all → publish all → stub restore → summary. Any failure exits 1. */
async function main(): Promise<void> {
  assertBunFloor("1.4.0");
  const scope = parseScope(process.env[SERVER_RELEASE_TRIPLES_ENV], SERVER_TARGETS, SERVER_RELEASE_TRIPLES_ENV);
  const destDir = resolveArtifactsDir();
  const outDir = join(SERVER_DIR, "dist", "release");
  await mkdir(outDir, { recursive: true });

  const result = await runRelease(
    {
      embed: {
        distIndexExists: () => existsSync(join(REPO_ROOT, "apps", "server", "web", "dist", "index.html")),
        runGenerator: async () => runBun(["run", "src/scripts/embed-web.ts"]),
      },
      build: { runBuild: runBun, outDir },
      publish: (artifacts, dest) => publishArtifacts(artifacts, dest),
      restoreEmbed: restoreStub,
      destDir,
    },
    scope,
  );
  if (!result.ok) {
    process.stderr.write(`\ncompile:release: FAILED building "${result.failed}" (nothing published)\n`);
    process.exit(1);
  }

  process.stdout.write(`\npublished ${result.artifacts.size} subshell-server builds → ${destDir}\n\n`);
  for (const [triple, { path, digest }] of result.artifacts) {
    const bytes = (await Bun.file(path).stat())?.size ?? 0;
    process.stdout.write(
      `  ${serverArtifactFileName(triple).padEnd(32)} ${String(bytes).padStart(12)} bytes  ${digest}\n`,
    );
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`compile:release: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
