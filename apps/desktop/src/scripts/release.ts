/**
 * `bun run compile:release` — the release pipeline for `apps/desktop`.
 *
 * Mirrors `apps/server/src/scripts/release.ts` beat for beat (assertBunFloor →
 * parseScope → preflight → build → assert → digest → publish, all-or-nothing,
 * CLI entry behind `import.meta.main`), with one step neither other pipeline
 * has: it BUILDS THE SERVER FIRST and stages it as the Tauri sidecar.
 *
 * Three rules about that server binary, each of which has a failure mode that
 * only shows up on a user's machine:
 *
 * 1. **`compile:release`, never `compile`.** Only the release build embeds the
 *    SPA into `src/generated/embedded-web.ts`. A plain `compile` ships the
 *    tracked stub (`EMBEDDED = false`), and `selectStaticPlugin` then throws at
 *    boot where there is no `apps/frontend/dist` to fall back to.
 * 2. **Never pre-signed, never separately notarized.** Tauri re-signs nested
 *    binaries with `--force` under the bundle's own identity and entitlements,
 *    and the app-level notarization mints tickets for nested files — so a
 *    prior signature is overwritten and a prior ticket binds to a cdhash that
 *    no longer exists. `SUBSHELL_RELEASE_SIGN_CMD` is explicitly cleared for
 *    the nested build.
 * 3. **The `.sha256` the server pipeline writes beside it is DELETED.** It
 *    describes the bytes before Tauri re-seals them, so keeping it publishes a
 *    digest that matches nothing. Digests are never comparable between the
 *    bare-binary download channel and this one.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_TARGETS,
  desktopArtifactFileName,
  desktopSidecarFileName,
  serverArtifactFileName,
} from "@internal/subshell-protocol";
import {
  assertBunFloor,
  type BuiltArtifact,
  digestFile,
  parseScope,
  publishArtifacts,
} from "@internal/subshell-protocol/release-artifacts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/desktop` — the cwd every tauri invocation runs in. */
export const DESKTOP_DIR = resolve(SCRIPT_DIR, "..", "..");
/** The monorepo root — where the nested server build is driven from. */
export const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..");
/** Where `externalBin` expects the staged sidecar. */
export const SIDECAR_DIR = join(DESKTOP_DIR, "src-tauri", "binaries");

/** The scope env var main() parses — exported so tests pin the SAME call shape. */
export const DESKTOP_RELEASE_TRIPLES_ENV = "SUBSHELL_DESKTOP_RELEASE_TRIPLES";
/** Where finished bundles are published. */
export const DESKTOP_RELEASE_DIR_ENV = "SUBSHELL_DESKTOP_RELEASE_DIR";

/** The Tauri bundler to run for a triple, and the directory it writes into. */
export function bundleKind(triple: string): { bundles: string; dir: string } {
  if (triple === "darwin-arm64") return { bundles: "app", dir: "macos" };
  if (triple === "linux-x64") return { bundles: "deb", dir: "deb" };
  throw new Error(`no bundler for '${triple}' (known: ${DESKTOP_TARGETS.join(", ")})`);
}

/**
 * `tauri build` argv.
 *
 * `--bundles` is the ENFORCEMENT of the target decision, not a preference:
 * `tauri.conf.json` only sets a default, and the Linux default is
 * deb+rpm+appimage — where the AppImage step downloads `linuxdeploy` at build
 * time and is the single most common failure inside a container.
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
  log: (line: string) => void;
}

/**
 * Build the server for `triple` and stage it under the name Tauri expects.
 *
 * The publish dir MUST be absolute: `resolveArtifactsDir()` on the server side
 * calls `resolve()` in the CHILD's cwd (`apps/server`), so a relative override
 * would land in `apps/server/apps/desktop/…` and the build would then fail
 * with "binary not found" pointing at a path that looks right.
 */
export async function stageSidecar(deps: DesktopReleaseDeps, triple: string): Promise<boolean> {
  deps.log(`staging the server sidecar for ${triple}…`);
  const code = await deps.run(["bun", "run", "--cwd", "apps/server", "compile:release"], REPO_ROOT, {
    SUBSHELL_SERVER_RELEASE_TRIPLES: triple,
    SUBSHELL_SERVER_RELEASE_DIR: SIDECAR_DIR,
    // Cleared, not merely unset: an inherited value from the CI shard would
    // sign and notarize a binary Tauri is about to re-seal — pure wall-clock,
    // and a `.sha256` that becomes a lie.
    SUBSHELL_RELEASE_SIGN_CMD: "",
  });
  if (code !== 0) return false;

  const built = join(SIDECAR_DIR, serverArtifactFileName(triple));
  if (!deps.exists(built)) {
    deps.log(`the server build reported success but ${built} is missing`);
    return false;
  }
  // The sidecar digest describes pre-seal bytes; keeping it publishes a lie.
  await deps.remove(`${built}.sha256`);
  await deps.move(built, join(SIDECAR_DIR, desktopSidecarFileName(triple)));
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
  const { dir } = bundleKind(triple);
  const surplus = present.filter((d) => d !== dir);
  if (surplus.length > 0) {
    throw new Error(`unexpected bundle output for ${triple}: ${surplus.join(", ")} (only ${dir} was requested)`);
  }
  if (!present.includes(dir)) {
    throw new Error(`tauri produced no ${dir} bundle for ${triple}`);
  }
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
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`apps/desktop/package.json has no usable version: '${version}'`);
  return version;
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
  log: (line) => console.log(line),
};

async function main(): Promise<void> {
  assertBunFloor("1.4.0");
  const scope = parseScope(process.env[DESKTOP_RELEASE_TRIPLES_ENV], DESKTOP_TARGETS, DESKTOP_RELEASE_TRIPLES_ENV);
  const targets = scope ?? [...DESKTOP_TARGETS];
  const version = await readVersion();
  const deps = DEFAULT_DEPS;

  // The nested server build embeds the SPA, so its own preflight needs this —
  // failing here rather than three minutes into a cargo build is the point.
  if (!deps.exists(join(REPO_ROOT, "apps", "frontend", "dist", "index.html"))) {
    console.error("apps/frontend/dist/index.html is missing — run `bunx turbo build` first");
    process.exit(1);
  }

  await mkdir(SIDECAR_DIR, { recursive: true });
  const artifacts = new Map<string, BuiltArtifact>();
  try {
    for (const triple of targets) {
      if (!(await stageSidecar(deps, triple))) {
        console.error(`the server sidecar for ${triple} failed to build — nothing published`);
        process.exit(1);
      }
      if ((await deps.run(["./node_modules/.bin/tauri", ...tauriBuildArgs(triple).slice(1)], DESKTOP_DIR)) !== 0) {
        console.error(`tauri build failed for ${triple} — nothing published`);
        process.exit(1);
      }
      const bundleRoot = join(DESKTOP_DIR, "src-tauri", "target", "release", "bundle");
      assertBundleSet(await listDirs(bundleRoot), triple);
      const path = await collectArtifact(deps, bundleRoot, triple, version);
      artifacts.set(triple, { path, digest: await digestFile(path) });
    }
  } finally {
    // The staged sidecar is a ~110 MB build input, never a leftover.
    await rm(SIDECAR_DIR, { recursive: true, force: true });
    await mkdir(SIDECAR_DIR, { recursive: true });
  }

  const dest = resolveReleaseDir();
  await publishArtifacts(artifacts, dest);
  console.log(`\npublished ${artifacts.size} desktop bundle(s) → ${dest}\n`);
  for (const [triple, a] of artifacts) console.log(`  ${triple.padEnd(16)} ${a.digest}`);
}

/** Directory names directly under `root`, or [] when it does not exist. */
async function listDirs(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Reduce a built bundle to ONE publishable file.
 *
 * macOS produces a `.app` DIRECTORY, which `digestFile`/`publishArtifacts`
 * cannot handle — it is tarred here. The `.app`'s stapled ticket is an ordinary
 * file inside it and survives the archive, which is what makes an offline first
 * launch work.
 */
async function collectArtifact(
  deps: DesktopReleaseDeps,
  bundleRoot: string,
  triple: string,
  version: string,
): Promise<string> {
  const name = desktopArtifactFileName(triple, version);
  if (triple === "linux-x64") return join(bundleRoot, "deb", name);
  const appDir = join(bundleRoot, "macos", "Subshell.app");
  const out = join(bundleRoot, "macos", name);
  // `--no-mac-metadata` keeps AppleDouble `._` members out; a member that
  // survives into the archive breaks the extracted bundle's signature.
  const code = await deps.run(
    ["tar", "--no-mac-metadata", "-czf", out, "-C", join(bundleRoot, "macos"), "Subshell.app"],
    DESKTOP_DIR,
  );
  if (code !== 0) throw new Error(`could not archive ${appDir}`);
  return out;
}

if (import.meta.main) {
  await main();
}
