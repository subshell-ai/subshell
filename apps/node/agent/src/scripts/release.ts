/**
 * `bun run compile:release` — the operator-facing release pipeline for the
 * `subshell` binaries (design 2026-09-02 §1). Builds every served target into
 * `dist/release/`, digests each with sha256, then publishes atomically (tmp +
 * rename) into the same directory `GET /api/downloads/node/*` serves (backend
 * `NODE_ARTIFACTS_DIR`). Every target builds with `--bytecode` (risk #9
 * retired — spike on bun 1.4.0, spec 2026-09-03 §1); `main()` asserts that
 * floor, and `SUBSHELL_RELEASE_TRIPLES` narrows the schedule for CI sharding
 * (spec §7).
 *
 * Deliberately SEPARATE from `compile` (host-only dev build): cross builds
 * download target runtimes over the network on first use, which must never
 * become a hidden cost of the normal build/test path. This file lives outside
 * `main.ts`'s import graph, so the compiled binary never sees it; import it in
 * tests only for the pure exports (the CLI entry is guarded by
 * `import.meta.main`).
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NODE_TARGETS,
  nodeArtifactFileName,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  resolveNodeArtifactsDir,
} from "@internal/subshell-protocol";
import {
  assertBunFloor,
  type BuiltArtifact,
  digestFile,
  parseScope as parseScopeTargets,
  publishArtifacts,
  releaseCommit,
  runSignHook,
  writeReleaseManifest,
} from "@internal/subshell-protocol/release-artifacts";
import { signPublishedReleaseManifest } from "@internal/subshell-protocol/release-signature";
import pkg from "../../package.json" with { type: "json" };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/node/agent` — the cwd every `bun build` invocation runs in (relative `./src/main.ts`). */
const AGENT_DIR = resolve(SCRIPT_DIR, "..", "..");
/** The monorepo root — where the `packages` dist outputs and hoisted workspace links live. */
const REPO_ROOT = resolve(AGENT_DIR, "..", "..", "..");

/** One entry of the build schedule. */
export interface BuildTarget {
  /** Platform triple this artifact is published under. */
  triple: string;
}

/**
 * The build schedule: one artifact per served triple (or per `scope` entry —
 * CI shards set `SUBSHELL_RELEASE_TRIPLES`, spec §7). Bytecode ships on EVERY
 * target: cross+bytecode was disproved a risk on bun 1.4.0 (spec 2026-09-03
 * spike), and the floor is asserted in main().
 * @param scope - triples to build; null/undefined = the full NODE_TARGETS set
 */
export function buildTargets(scope: readonly string[] | null = null): BuildTarget[] {
  const set = scope ?? [...NODE_TARGETS];
  return set.map((triple) => ({ triple }));
}

/**
 * `bun build` argv for one target (spawned with cwd `apps/node/agent`).
 * Uniform: `--compile --bytecode --minify --target=bun-<triple>` — the
 * host-wins-its-triple special case is retired (spec 2026-09-03 §5).
 * @param triple - platform triple to build
 * @param outDir - directory for the `subshell-node-cli-<triple>` output file
 */
export function buildArgs(triple: string, outDir: string): string[] {
  return [
    "build",
    "--compile",
    "--bytecode",
    "--minify",
    "./src/main.ts",
    `--target=bun-${triple}`,
    "--outfile",
    join(outDir, nodeArtifactFileName(triple)),
  ];
}

/**
 * Parse the `SUBSHELL_RELEASE_TRIPLES` scope override against NODE_TARGETS —
 * the parse/refusal itself moved to the shared {@link parseScopeTargets}
 * (plan 2 Task E DRY-up) so both apps' pipelines reject typos identically;
 * this wrapper only pins the known set and the env-var name to cite.
 * @returns null when unset/blank (the full set)
 */
export function parseScope(raw: string | undefined): string[] | null {
  return parseScopeTargets(raw, NODE_TARGETS, "SUBSHELL_RELEASE_TRIPLES");
}

/** Injectable build runner for tests (a real spawn in `main`). */
export interface ReleaseDeps {
  /** Runs one `bun build` argv (relative to `apps/node/agent`); resolves with its exit code. */
  runBuild(args: string[]): Promise<number>;
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
 * — callers run {@link publishArtifacts} only on `ok:true`, so a failed target
 * publishes nothing (all-or-nothing, design §1).
 * @param deps - injected runner + output directory
 * @param scope - triples to build; null/undefined = the full served set
 */
export async function buildAll(deps: ReleaseDeps, scope?: string[] | null): Promise<BuildAllResult> {
  const artifacts = new Map<string, BuiltArtifact>();
  for (const target of buildTargets(scope ?? null)) {
    const code = await deps.runBuild(buildArgs(target.triple, deps.outDir));
    if (code !== 0) return { ok: false, failed: target.triple };
    const path = join(deps.outDir, nodeArtifactFileName(target.triple));
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

/**
 * The publish destination — the env ladder shared with the backend's
 * `NODE_ARTIFACTS_DIR` via `resolveNodeArtifactsDir`
 * (`@internal/subshell-protocol` paths.ts): `SUBSHELL_NODE_ARTIFACTS_DIR`, else
 * `<SUBSHELL_SERVER_DATA_DIR>/node-artifacts`, else the DATABASE_PATH-derived data
 * dir. Resolved against THIS cwd (the ladder is the contract; the cwd
 * difference between the two apps is why only the ladder is shared).
 */
export function resolveArtifactsDir(): string {
  return resolve(
    resolveNodeArtifactsDir({
      SUBSHELL_NODE_ARTIFACTS_DIR: process.env.SUBSHELL_NODE_ARTIFACTS_DIR,
      SUBSHELL_SERVER_DATA_DIR: process.env.SUBSHELL_SERVER_DATA_DIR,
      DATABASE_PATH: process.env.DATABASE_PATH,
    }),
  );
}

/** Runs one `bun` subcommand argv in `apps/node/agent` with output streamed to this console. */
async function runBun(args: string[]): Promise<number> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: AGENT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

/** Refuses (exit 1) unless the workspace dist outputs the compiled client links against exist. */
function assertWorkspaceBuilt(): boolean {
  const linked =
    existsSync(join(AGENT_DIR, "node_modules", "@internal", "pane-runtime")) ||
    existsSync(join(REPO_ROOT, "node_modules", "@internal", "pane-runtime"));
  // tsdown's ESM extension for @internal/pane-runtime is .mjs today (its
  // package.json points at dist/index.mjs); accept either spelling so the
  // gate tracks "the dist output exists", not one bundler config.
  const distDir = join(REPO_ROOT, "packages", "pane-runtime", "dist");
  const built = existsSync(join(distDir, "index.mjs")) || existsSync(join(distDir, "index.js"));
  if (linked && built) return true;
  process.stderr.write(
    "compile:release: workspace build outputs are missing (packages/pane-runtime/dist). " +
      "run `turbo build` first from the repo root.\n",
  );
  return false;
}

/**
 * There is deliberately NO plugin-embed step in this pipeline, although the
 * server's has one.
 *
 * `EMBEDDED_PLUGINS` is the checkout-less fallback for the INSTANCE plugin
 * store, and the store lives on the control plane alone (inversion spec
 * 2026-09-10 §6): the agent seeds nothing, installs nothing, and reads no
 * plugin bytes at runtime — its launches execute the plane-built argv with
 * the `detect`/`resolve` rules shipped to it as data. An embed here would
 * bake 84 KB nothing in this binary ever reads; the step existed from the
 * pre-inversion era and its "ships an empty embedded set ⇒ refuses every
 * launch" rationale died with the node-side store. (It was also inert even
 * as bytes: regenerating `src/generated/embedded-plugins.ts` reaches a
 * compiled binary only through a rebuilt pane-runtime dist, which this
 * pipeline never ran — see the server's `runEmbedPlugins` for what a step
 * that matters has to do.)
 */

/** CLI entry: floor + scope → preflight → build all → publish all → summary table. Any failure exits 1. */
async function main(): Promise<void> {
  assertBunFloor("1.4.0");
  const scope = parseScope(process.env.SUBSHELL_RELEASE_TRIPLES);
  if (!assertWorkspaceBuilt()) process.exit(1);
  const destDir = resolveArtifactsDir();
  // #8 (final review): the default ladder resolves against THIS script's cwd,
  // while the backend resolves the same ladder against ITS cwd — equal only
  // for absolute inputs. With nothing set in the environment, say so loudly
  // instead of silently publishing where the server may not look.
  if (!process.env.SUBSHELL_NODE_ARTIFACTS_DIR && !process.env.SUBSHELL_SERVER_DATA_DIR && !process.env.DATABASE_PATH) {
    process.stderr.write(
      `note: destination derived from the DEFAULT ladder against this script's cwd; if the backend runs ` +
        `with a different cwd or its own .env, confirm it serves:\n      ${destDir}\n`,
    );
  }
  const outDir = join(AGENT_DIR, "dist", "release");
  await mkdir(outDir, { recursive: true });

  // No embed step here, and no stub to restore: the agent reads no plugin
  // bytes (see the note above the build schedule). What the binary carries of
  // pane-runtime is its compiled code, which `bun build` bundles either way.
  const result = await buildAll({ runBuild: runBun, outDir }, scope);
  if (!result.ok) {
    process.stderr.write(`\ncompile:release: FAILED building "${result.failed}" (nothing published)\n`);
    process.exit(1);
  }

  await publishArtifacts(result.artifacts, destDir);
  // The fifth asset (spec 2026-09-15 §3.2). A control plane reads THIS to
  // decide whether it can talk to the agent in a release, so it is written
  // only after a complete build has published. Its `assets` map carries the
  // digests this pipeline already computed for the sidecars (spec 2026-09-17
  // D2) — the signed manifest, not the sidecar file, is what every consumer
  // verifies the bytes against from here on.
  const assets: Record<string, string> = {};
  for (const [, { path, digest }] of result.artifacts) assets[basename(path)] = digest;
  const manifest = await writeReleaseManifest(destDir, {
    component: "cli-node",
    version: pkg.version,
    commit: releaseCommit(),
    assets,
  });
  // The sixth: the publisher signature over the manifest's exact bytes
  // (spec 2026-09-17). With `TAURI_SIGNING_PRIVATE_KEY` set (CI sets it for
  // every shard; the workflow refuses the shard before this step when it is
  // missing), the release is signed and every plane can verify it offline.
  // Without it the artifacts still publish — a local `release:cli-node` into
  // one's own instance is a legitimate digest-served install — but the
  // operator hears, from this pipeline's own output, that no plane will
  // OFFER it for update until a shard with the key cuts the release.
  const signed = await signPublishedReleaseManifest(destDir, manifest);

  process.stdout.write(`\npublished ${result.artifacts.size} subshell builds → ${destDir}\n\n`);
  for (const [triple, { path, digest }] of result.artifacts) {
    const bytes = (await Bun.file(path).stat())?.size ?? 0;
    process.stdout.write(
      `  ${nodeArtifactFileName(triple).padEnd(28)} ${String(bytes).padStart(12)} bytes  ${digest}\n`,
    );
  }
  process.stdout.write(
    `  ${RELEASE_MANIFEST_NAME.padEnd(28)} protocol ${manifest.nodeProtocol}, min agent ${manifest.minNodeVersion}\n`,
  );
  process.stdout.write(
    signed === "signed"
      ? `  ${RELEASE_MANIFEST_SIG_NAME.padEnd(28)} signed by the publisher key\n`
      : `  ${RELEASE_MANIFEST_SIG_NAME.padEnd(28)} UNSIGNED — TAURI_SIGNING_PRIVATE_KEY not set; no plane will offer this release for update\n`,
  );
  process.stdout.write(
    "\nrestart `subshell-server.service` to serve them: systemctl --user restart subshell-server.service\n",
  );
}

if (import.meta.main) {
  void main();
}
