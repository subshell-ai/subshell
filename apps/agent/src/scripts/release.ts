/**
 * `bun run compile:release` — the operator-facing release pipeline for the
 * `subshell` binaries (design 2026-09-02 §1). Cross-compiles the four served
 * targets plus a bytecode-optimised host build into `dist/release/`, digests
 * each with sha256, then publishes atomically (tmp + rename) into the same
 * directory `GET /api/downloads/node/*` serves (backend `NODE_ARTIFACTS_DIR`).
 *
 * Deliberately SEPARATE from `compile` (host-only dev build): cross builds
 * download target runtimes over the network on first use and run WITHOUT
 * `--bytecode` (spec risk #9), which must never become a hidden cost of the
 * normal build/test path. This file lives outside `main.ts`'s import graph, so
 * the compiled binary never sees it; import it in tests only for the pure
 * exports (the CLI entry is guarded by `import.meta.main`).
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { NODE_TARGETS, nodeArtifactFileName, resolveNodeArtifactsDir } from "@internal/session-protocol";

/**
 * Streaming sha256 (lowercase hex) of a file — the ~100 MB compiled binaries
 * never enter memory. Reusable so tests digest with the PRODUCTION helper
 * instead of mirroring the hasher expression.
 */
export async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/agent` — the cwd every `bun build` invocation runs in (relative `./src/main.ts`). */
const AGENT_DIR = resolve(SCRIPT_DIR, "..", "..");
/** The monorepo root — where the `packages` dist outputs and hoisted workspace links live. */
const REPO_ROOT = resolve(AGENT_DIR, "..", "..");

/**
 * The closed set of cross-compiled platform triples — the SAME served set
 * the backend's downloads route gates on (single source of truth in
 * `@internal/session-protocol`). Named `CROSS_TARGETS` here because in the
 * build schedule every entry is a cross build UNLESS the host wins it.
 */
export const CROSS_TARGETS = NODE_TARGETS;

/**
 * Maps a platform/arch pair to its served triple.
 * @param platform - Node platform string (defaults to this process's)
 * @param arch - Node arch string (defaults to this process's)
 * @returns the triple, or null when the pair is not one of the four served targets
 */
export function hostTriple(platform: string = process.platform, arch: string = process.arch): string | null {
  const triple = `${platform}-${arch}`;
  return (CROSS_TARGETS as readonly string[]).includes(triple) ? triple : null;
}

/** One entry of the build schedule. */
export interface BuildTarget {
  /** Platform triple this artifact is published under. */
  triple: string;
  /** True for the host build — the only one that ships with `--bytecode`. */
  isHost: boolean;
}

/**
 * The build schedule: the four cross targets plus the host build. One artifact
 * per triple — when the host arch duplicates a cross triple the HOST entry wins
 * it (4 entries on a linux-x64 box). A foreign host yields 4 too (cross builds
 * only — `hostTriple()` returns null and `main()` warns); a 5th entry exists
 * only through an explicit override, which never happens in production.
 * @param host - host triple override (tests; null = unsupported host)
 */
export function buildTargets(host: string | null = hostTriple()): BuildTarget[] {
  const targets: BuildTarget[] = CROSS_TARGETS.filter((t) => t !== host).map((triple) => ({
    triple,
    isHost: false,
  }));
  if (host) targets.push({ triple: host, isHost: true });
  return targets;
}

/**
 * `bun build` argv for one target (spawned with cwd `apps/agent`).
 * Cross: `--compile --minify --target=bun-<triple>`. Host: same plus
 * `--bytecode`, and NO `--target` — a foreign target with bytecode is spec
 * risk #9, so the flags are mutually exclusive by construction here.
 * @param triple - platform triple to build
 * @param isHost - whether this is the host (bytecode, native-target) build
 * @param outDir - directory for the `subshell-<triple>` output file
 */
export function buildArgs(triple: string, isHost: boolean, outDir: string): string[] {
  return [
    "build",
    "--compile",
    ...(isHost ? ["--bytecode"] : []),
    "--minify",
    "./src/main.ts",
    ...(isHost ? [] : [`--target=bun-${triple}`]),
    "--outfile",
    join(outDir, nodeArtifactFileName(triple)),
  ];
}

/** Injectable build runner for tests (a real spawn in `main`). */
export interface ReleaseDeps {
  /** Runs one `bun build` argv (relative to `apps/agent`); resolves with its exit code. */
  runBuild(args: string[]): Promise<number>;
  /** Directory the compiled binaries are written to. */
  outDir: string;
}

/** A compiled, digested artifact awaiting publication. */
export interface BuiltArtifact {
  /** Absolute path of the built file inside `outDir`. */
  path: string;
  /** Lowercase 64-hex sha256 of the file's bytes. */
  digest: string;
}

/** Result of {@link buildAll} — either the full artifact set or the first triple that failed. */
export type BuildAllResult = { ok: true; artifacts: Map<string, BuiltArtifact> } | { ok: false; failed: string };

/**
 * Builds every target and digests it. NEVER publishes — callers run
 * {@link publishArtifacts} only on `ok:true`, so a failed target publishes
 * nothing (all-or-nothing, design §1).
 * @param deps - injected runner + output directory
 */
export async function buildAll(deps: ReleaseDeps): Promise<BuildAllResult> {
  const artifacts = new Map<string, BuiltArtifact>();
  for (const target of buildTargets()) {
    const code = await deps.runBuild(buildArgs(target.triple, target.isHost, deps.outDir));
    if (code !== 0) return { ok: false, failed: target.triple };
    const path = join(deps.outDir, nodeArtifactFileName(target.triple));
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

/**
 * Publishes artifacts to `destDir`: `copyFile → <name>.tmp-<pid> → rename` so
 * the downloads route's mtime-keyed sha cache can never observe a half-written
 * binary, plus a freshly generated `.sha256` sidecar (64-hex + `\n`) per
 * target — a stale sidecar is always overwritten, never reused.
 *
 * ATOMICITY IS PER-FILE: the binary swap is atomic, the sidecar write is not,
 * so a download landing in the window between them can pair a new binary with
 * the previous digest. That fails SAFE (install.sh's digest check refuses the
 * exec; a retry gets the pair) on a rare operator-published path — noted so
 * the atomicity claim is never stronger than the mechanism.
 * @param artifacts - triple → built artifact map from {@link buildAll}
 * @param destDir - directory to publish into (created when missing)
 */
export async function publishArtifacts(artifacts: Map<string, BuiltArtifact>, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const [triple, { path, digest }] of artifacts) {
    const dest = join(destDir, nodeArtifactFileName(triple));
    const tmp = `${dest}.tmp-${process.pid}`;
    await copyFile(path, tmp);
    await rename(tmp, dest);
    await Bun.write(`${dest}.sha256`, `${digest}\n`);
  }
}

/**
 * The publish destination — the env ladder shared with the backend's
 * `NODE_ARTIFACTS_DIR` via `resolveNodeArtifactsDir`
 * (`@internal/session-protocol` paths.ts): `SUBSHELL_NODE_ARTIFACTS_DIR`, else
 * `<SESSION_DATA_DIR>/node-artifacts`, else the DATABASE_PATH-derived data
 * dir. Resolved against THIS cwd (the ladder is the contract; the cwd
 * difference between the two apps is why only the ladder is shared).
 */
export function resolveArtifactsDir(): string {
  return resolve(
    resolveNodeArtifactsDir({
      SUBSHELL_NODE_ARTIFACTS_DIR: process.env.SUBSHELL_NODE_ARTIFACTS_DIR,
      SESSION_DATA_DIR: process.env.SESSION_DATA_DIR,
      DATABASE_PATH: process.env.DATABASE_PATH,
    }),
  );
}

/** Runs one `bun` subcommand argv in `apps/agent` with output streamed to this console. */
async function runBun(args: string[]): Promise<number> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: AGENT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

/** Refuses (exit 1) unless the workspace dist outputs the compiled agent links against exist. */
function assertWorkspaceBuilt(): boolean {
  const linked =
    existsSync(join(AGENT_DIR, "node_modules", "@internal", "harnesses")) ||
    existsSync(join(REPO_ROOT, "node_modules", "@internal", "harnesses"));
  // tsdown's ESM extension for @internal/harnesses is .mjs today (its
  // package.json points at dist/index.mjs); accept either spelling so the
  // gate tracks "the dist output exists", not one bundler config.
  const distDir = join(REPO_ROOT, "packages", "harnesses", "dist");
  const built = existsSync(join(distDir, "index.mjs")) || existsSync(join(distDir, "index.js"));
  if (linked && built) return true;
  process.stderr.write(
    "compile:release: workspace build outputs are missing (packages/harnesses/dist) — " +
      "run `turbo build` first from the repo root.\n",
  );
  return false;
}

/** CLI entry: preflight → build all → publish all → summary table. Any failure exits 1. */
async function main(): Promise<void> {
  if (!assertWorkspaceBuilt()) process.exit(1);
  if (!hostTriple()) {
    process.stdout.write(
      `note: host ${process.platform}-${process.arch} is not a served triple — publishing the cross builds only\n`,
    );
  }
  const destDir = resolveArtifactsDir();
  // #8 (final review): the default ladder resolves against THIS script's cwd,
  // while the backend resolves the same ladder against ITS cwd — equal only
  // for absolute inputs. With nothing set in the environment, say so loudly
  // instead of silently publishing where the server may not look.
  if (!process.env.SUBSHELL_NODE_ARTIFACTS_DIR && !process.env.SESSION_DATA_DIR && !process.env.DATABASE_PATH) {
    process.stderr.write(
      `note: destination derived from the DEFAULT ladder against this script's cwd — if the backend runs ` +
        `with a different cwd or its own .env, confirm it serves:\n      ${destDir}\n`,
    );
  }
  const outDir = join(AGENT_DIR, "dist", "release");
  await mkdir(outDir, { recursive: true });

  const result = await buildAll({ runBuild: runBun, outDir });
  if (!result.ok) {
    process.stderr.write(`\ncompile:release: FAILED building "${result.failed}" (nothing published)\n`);
    process.exit(1);
  }

  await publishArtifacts(result.artifacts, destDir);

  process.stdout.write(`\npublished ${result.artifacts.size} subshell builds → ${destDir}\n\n`);
  for (const [triple, { path, digest }] of result.artifacts) {
    const bytes = (await Bun.file(path).stat())?.size ?? 0;
    process.stdout.write(`  subshell-${triple.padEnd(12)} ${String(bytes).padStart(12)} bytes  ${digest}\n`);
  }
  process.stdout.write(
    "\nrestart `subshell-server.service` to serve them: systemctl --user restart subshell-server.service\n",
  );
}

if (import.meta.main) {
  void main();
}
