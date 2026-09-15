/**
 * `bun run compile:release` — the release pipeline for `apps/client/desktop`.
 *
 * Beat for beat the pipeline `apps/server/desktop/src/scripts/release.ts`
 * runs (assertBunFloor → parseScope → preflight → stage sidecar → bundle →
 * assert the bundle set → glob the one artifact the bundler wrote → digest →
 * publish, all-or-nothing, CLI entry behind `import.meta.main`). Exactly one thing differs: the nested product. This app
 * ships the NODE AGENT (`apps/node/agent` → `subshell`), not the server, so the
 * child build, the env vars that steer it, the staged file name and the
 * product name all come from the agent's half of the distribution contract in
 * `@internal/subshell-protocol`.
 *
 * Four rules about that staged agent, each with a failure that only appears on
 * a user's machine:
 *
 * 1. **`compile:release`, never `compile`.** `compile` is the host-only dev
 *    build: it produces one binary for whatever machine ran it, with no
 *    `--bytecode` and no cross target, so a `darwin-arm64` bundle built on a
 *    Linux shard would ship a Linux ELF the `.app` cannot exec.
 * 2. **Never pre-signed, never separately notarized.** Tauri re-signs nested
 *    binaries with `--force` under the bundle's own identity and entitlements,
 *    and the app-level notarization mints tickets for nested files — so a
 *    prior signature is overwritten and a prior ticket binds to a cdhash that
 *    no longer exists. `SUBSHELL_RELEASE_SIGN_CMD` is CLEARED (set empty, not
 *    merely left alone) for the nested build.
 * 3. **The `.sha256` the agent pipeline writes beside it is DELETED.** It
 *    describes the bytes before Tauri re-seals them, so keeping it publishes a
 *    digest that matches nothing. Digests are never comparable between the
 *    bare-binary download channel (`GET /api/downloads/node/*`) and this one.
 * 4. **`SUBSHELL_NODE_ARTIFACTS_DIR` must be ABSOLUTE.** `resolveArtifactsDir()`
 *    on the agent side calls `resolve()` in the CHILD's cwd (`apps/node/agent`),
 *    so a relative override lands in `apps/node/agent/apps/client/desktop/…` — a
 *    path that looks right in the log and is not, and the build then fails with
 *    "binary not found" pointing somewhere else entirely.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_SIDECAR_NAME,
  DESKTOP_CLIENT_PRODUCT,
  DESKTOP_TARGETS,
  desktopArtifactFileName,
  desktopSidecarFileName,
  nodeArtifactFileName,
  RELEASE_MANIFEST_NAME,
} from "@internal/subshell-protocol";
import {
  assertBunFloor,
  type BuiltArtifact,
  digestFile,
  notarizeAndStapleDmg,
  parseScope,
  publishArtifacts,
  releaseCommit,
  selectBundleOutput,
  writeReleaseManifest,
} from "@internal/subshell-protocol/release-artifacts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/client/desktop` — the cwd every tauri invocation runs in. */
export const DESKTOP_DIR = resolve(SCRIPT_DIR, "..", "..");
/** The monorepo root — where the nested agent build is driven from. */
export const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..", "..");
/** Where `externalBin` expects the staged sidecar. */
export const SIDECAR_DIR = join(DESKTOP_DIR, "src-tauri", "binaries");

/**
 * The scope env var main() parses — exported so tests pin the SAME call shape.
 * It is the same NAME `apps/server/desktop` reads, deliberately: the release
 * workflow sets these two once for whichever desktop shard is running.
 */
export const DESKTOP_RELEASE_TRIPLES_ENV = "SUBSHELL_DESKTOP_RELEASE_TRIPLES";
/** Where finished bundles are published. */
export const DESKTOP_RELEASE_DIR_ENV = "SUBSHELL_DESKTOP_RELEASE_DIR";

/**
 * The Tauri bundler to run for a triple, the directory it writes into, and
 * what the thing it writes there is called at the end.
 *
 * `suffix` is what the pipeline GLOBS for. The bundler's own name for its
 * output is not predictable — `productName` reaches the `.deb` file name
 * through Debian's package-name sanitizer and the `.dmg` file name through
 * Tauri's own versioning — so the only durable fact is the extension.
 *
 * `intermediates` are directories the bundler legitimately fills but whose
 * contents are never published: building a DMG produces the `.app` under
 * `macos/` and stages create-dmg's support files under `share/`, and the image
 * under `dmg/` is what gets shipped.
 */
export function bundleKind(triple: string): {
  bundles: string;
  dir: string;
  suffix: string;
  intermediates: readonly string[];
} {
  if (triple === "darwin-arm64")
    return { bundles: "dmg", dir: "dmg", suffix: ".dmg", intermediates: ["macos", "share"] };
  if (triple === "linux-x64") return { bundles: "deb", dir: "deb", suffix: ".deb", intermediates: [] };
  throw new Error(`no bundler for '${triple}' (known: ${DESKTOP_TARGETS.join(", ")})`);
}

/**
 * `tauri build` argv.
 *
 * `--bundles` is the ENFORCEMENT of the target decision, not a preference:
 * `tauri.conf.json` only sets a default, and the Linux default includes an
 * AppImage whose bundler downloads `linuxdeploy` at build time — the single
 * most common failure inside a container.
 */
export function tauriBuildArgs(triple: string): string[] {
  return ["tauri", "build", "--bundles", bundleKind(triple).bundles];
}

/** Injected effects, so the pipeline is testable without building anything. */
export interface DesktopReleaseDeps {
  /** Run a command in a directory; resolves to its exit code. */
  run: (argv: string[], cwd: string, env?: Record<string, string>) => Promise<number>;
  /** Whether a path exists. */
  exists: (path: string) => boolean;
  /** Remove a file, tolerating its absence. */
  remove: (path: string) => Promise<void>;
  /** Rename a file. */
  move: (from: string, to: string) => Promise<void>;
  /** Entry names directly under a directory — how the bundler's output is FOUND. */
  list: (dir: string) => Promise<string[]>;
  /** Run a command capturing combined output — what notarytool's verdict is READ from. */
  runCapture: (argv: string[]) => Promise<{ code: number; output: string }>;
  log: (line: string) => void;
}

/**
 * Build the node agent for `triple` and stage it under the name Tauri expects.
 *
 * The three env vars handed to the child are the whole contract with
 * `apps/node/agent`'s own pipeline: scope it to one triple, publish it into the
 * sidecar directory by ABSOLUTE path (rule 4 in this file's header), and sign
 * nothing (rule 2).
 */
export async function stageSidecar(deps: DesktopReleaseDeps, triple: string): Promise<boolean> {
  deps.log(`staging the node agent sidecar for ${triple}…`);
  const code = await deps.run(["bun", "run", "--cwd", "apps/node/agent", "compile:release"], REPO_ROOT, {
    SUBSHELL_RELEASE_TRIPLES: triple,
    SUBSHELL_NODE_ARTIFACTS_DIR: SIDECAR_DIR,
    // Cleared, not merely unset: an inherited value from the CI shard would
    // sign and notarize a binary Tauri is about to re-seal — pure wall-clock,
    // and a `.sha256` that becomes a lie.
    SUBSHELL_RELEASE_SIGN_CMD: "",
  });
  if (code !== 0) return false;

  const built = join(SIDECAR_DIR, nodeArtifactFileName(triple));
  if (!deps.exists(built)) {
    deps.log(`the agent build reported success but ${built} is missing`);
    return false;
  }
  // The sidecar digest describes pre-seal bytes; keeping it publishes a lie.
  await deps.remove(`${built}.sha256`);
  // Same rule for the nested build's release manifest: it describes the NODE
  // release, and this directory is a Tauri build input, not a publish dir.
  // This app writes its OWN manifest into the publish dir at the end of main().
  await deps.remove(join(SIDECAR_DIR, RELEASE_MANIFEST_NAME));
  // MOVED, never re-created: `rename()` keeps the 0755 the compiler wrote.
  // Anything that stages this file by copying its bytes (a CI artifact
  // download, an unzip) must restore the mode — `install -m 755` — because a
  // sidecar that ships 0644 dies EACCES at exec, invisibly until first run.
  await deps.move(built, join(SIDECAR_DIR, desktopSidecarFileName(AGENT_SIDECAR_NAME, triple)));
  return true;
}

/**
 * Assert that `tauri build` produced EXACTLY the bundle we asked for.
 *
 * A surplus bundle is not a warning: the publish job's file glob takes
 * everything under each downloaded artifact directory, so an AppImage nobody
 * decided to ship would ship.
 */
export function assertBundleSet(present: readonly string[], triple: string): void {
  const { dir, intermediates } = bundleKind(triple);
  const surplus = present.filter((d) => d !== dir && !intermediates.includes(d));
  if (surplus.length > 0) {
    throw new Error(`unexpected bundle output for ${triple}: ${surplus.join(", ")} (only ${dir} was requested)`);
  }
  if (!present.includes(dir)) {
    throw new Error(`tauri produced no ${dir} bundle for ${triple}`);
  }
}

/**
 * The one target this machine can actually build.
 *
 * `tauri build` links against the host webview, so a cross-build is not a slow
 * path — it is not a path. CI scopes every shard explicitly; a local run gets
 * the host, and a host with no buildable target is refused rather than guessed.
 */
export function hostTarget(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  throw new Error(
    `apps/client/desktop cannot be built on ${platform}-${arch} (buildable here: ${DESKTOP_TARGETS.join(", ")})`,
  );
}

/** Where finished bundles are published: the env override, else `<repo>/dist-rel`. */
export function resolveReleaseDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = env[DESKTOP_RELEASE_DIR_ENV];
  return explicit && explicit.length > 0 ? resolve(explicit) : join(REPO_ROOT, "dist-rel");
}

/** Read the app version the bundle will carry. */
export async function readVersion(): Promise<string> {
  const pkg = await Bun.file(join(DESKTOP_DIR, "package.json")).json();
  const version = String(pkg.version ?? "");
  if (!/^\d+\.\d+\.\d+/.test(version))
    throw new Error(`apps/client/desktop/package.json has no usable version: '${version}'`);
  return version;
}

/** What `tauri build` wrote for a triple, and the ONE file that is published. */
export interface BundleArtifact {
  /**
   * What the bundler produced, under ITS OWN name — a `.deb` or `.dmg` FILE
   * whose exact spelling only the bundler decides.
   */
  source: string;
  /** The single file handed to `digestFile`/`publishArtifacts`, under this repo's name for it. */
  artifact: string;
}

/**
 * Map what the bundler actually wrote to the file this pipeline publishes.
 *
 * `emitted` is DISCOVERED (globbed by {@link collectArtifact}), never
 * predicted: Tauri derives the `.deb` and `.dmg` file names from `productName`
 * and its own versioning, the Debian one through a package-name sanitizer that
 * cannot be reasoned about without running the Linux bundler. Predicting names
 * is what forced both apps to be named in single tokens.
 *
 * The published name is this repo's own choice
 * ({@link desktopArtifactFileName}) and is space-free, because it is a
 * download URL and a shell argument. The `.app` inside the DMG keeps its
 * spaced name — that is what the user installs.
 */
export function bundleArtifact(bundleRoot: string, triple: string, version: string, emitted: string): BundleArtifact {
  const { dir } = bundleKind(triple);
  return {
    source: join(bundleRoot, dir, emitted),
    artifact: join(bundleRoot, dir, desktopArtifactFileName(DESKTOP_CLIENT_PRODUCT, triple, version)),
  };
}

/**
 * Reduce a built bundle to ONE publishable file.
 *
 * Finds the bundler's output by globbing `bundle/<dir>` for the one entry with
 * the right extension — exactly one, or a refusal (see
 * {@link selectBundleOutput}) — and renames it into this repo's published
 * name. Both artifacts are single FILES, so nothing is archived and the digest
 * describes the exact bytes a user downloads. Tauri only SIGNS the image —
 * {@link notarizeAndStapleDmg} completes notarization and stapling right after
 * this step, BEFORE the digest, and the CI smoke re-validates the staple.
 */
export async function collectArtifact(
  deps: DesktopReleaseDeps,
  bundleRoot: string,
  triple: string,
  version: string,
): Promise<string> {
  const { dir, suffix } = bundleKind(triple);
  const bundleDir = join(bundleRoot, dir);
  const emitted = selectBundleOutput(await deps.list(bundleDir), suffix, bundleDir);
  const { source, artifact } = bundleArtifact(bundleRoot, triple, version, emitted);
  // The bundler's name is Tauri's; the published one is ours.
  if (source !== artifact) await deps.move(source, artifact);
  return artifact;
}

const runProcess = async (argv: string[], cwd: string, env?: Record<string, string>): Promise<number> => {
  const child = Bun.spawn(argv, { cwd, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  return await child.exited;
};

/** The real effects. */
export const DEFAULT_DEPS: DesktopReleaseDeps = {
  run: runProcess,
  exists: existsSync,
  remove: async (path) => {
    await rm(path, { force: true });
  },
  move: rename,
  list: (dir) => readdir(dir),
  runCapture: async (argv) => {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    // Both pipes drained BEFORE awaiting exit — a child outgrowing the pipe
    // buffer while nobody reads it is the classic deadlock.
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, output: `${out}${err}` };
  },
  log: (line) => console.log(line),
};

async function main(): Promise<void> {
  assertBunFloor("1.4.0");
  const scope = parseScope(process.env[DESKTOP_RELEASE_TRIPLES_ENV], DESKTOP_TARGETS, DESKTOP_RELEASE_TRIPLES_ENV);
  // Unlike the bun pipelines, `tauri build` cannot cross-compile: it links
  // against the host's own webview. So the unscoped default is the HOST triple,
  // not the full set — a default nobody can run is not a default.
  const targets = scope ?? [hostTarget()];
  const version = await readVersion();
  const deps = DEFAULT_DEPS;

  // The nested agent build BUNDLES the workspace dists, and refuses without
  // them (`assertWorkspaceBuilt` in apps/node/agent's pipeline). Mirroring that
  // gate here fails in a second rather than after a full cargo build.
  const paneRuntimeDist = join(REPO_ROOT, "packages", "pane-runtime", "dist");
  if (!deps.exists(join(paneRuntimeDist, "index.mjs")) && !deps.exists(join(paneRuntimeDist, "index.js"))) {
    console.error("the workspace dists are missing (packages/pane-runtime/dist). Run `bunx turbo build` first");
    process.exit(1);
  }

  await mkdir(SIDECAR_DIR, { recursive: true });
  const artifacts = new Map<string, BuiltArtifact>();
  try {
    for (const triple of targets) {
      if (!(await stageSidecar(deps, triple))) {
        throw new Error(`the node agent sidecar for ${triple} failed to build — nothing published`);
      }
      const bundleRoot = join(DESKTOP_DIR, "src-tauri", "target", "release", "bundle");
      // A previous target's output would otherwise make `assertBundleSet` fail
      // a perfectly good build, and its message name a bundler that did not run.
      await rm(bundleRoot, { recursive: true, force: true });
      if ((await deps.run(["./node_modules/.bin/tauri", ...tauriBuildArgs(triple).slice(1)], DESKTOP_DIR)) !== 0) {
        throw new Error(`tauri build failed for ${triple} — nothing published`);
      }
      assertBundleSet(await listDirs(bundleRoot), triple);
      const path = await collectArtifact(deps, bundleRoot, triple, version);
      // Tauri signs the image but stops there; the digest below must describe
      // the NOTARIZED, STAPLED bytes, so the chain completes first.
      if (triple === "darwin-arm64" && !(await notarizeAndStapleDmg(path, deps))) {
        throw new Error(`the ${triple} DMG failed notarization/stapling — nothing published`);
      }
      artifacts.set(triple, { path, digest: await digestFile(path) });
    }
  } finally {
    // The staged sidecar is a ~100 MB build input, never a leftover. Only the
    // staged files — `binaries/.gitkeep` is tracked, and wiping the directory
    // would delete it on every successful build.
    for (const target of DESKTOP_TARGETS) {
      await rm(join(SIDECAR_DIR, desktopSidecarFileName(AGENT_SIDECAR_NAME, target)), { force: true });
    }
  }

  const dest = resolveReleaseDir();
  await publishArtifacts(artifacts, dest);
  // The fifth asset (spec 2026-09-15 §3.2), after a complete publish: the
  // Updates page reads it to say which desktop version is available.
  const manifest = await writeReleaseManifest(dest, {
    component: "desktop-client",
    version,
    commit: releaseCommit(),
  });
  console.log(`\npublished ${artifacts.size} desktop bundle(s) → ${dest}\n`);
  for (const [triple, a] of artifacts) console.log(`  ${triple.padEnd(16)} ${a.digest}`);
  console.log(`  ${RELEASE_MANIFEST_NAME.padEnd(16)} ${manifest.component} ${manifest.version} @ ${manifest.commit}`);
}

/** Directory names directly under `root`, or [] when it does not exist. */
async function listDirs(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
