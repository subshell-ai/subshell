/**
 * `bun run compile:release` — the release pipeline for `apps/server/desktop`.
 *
 * Mirrors `apps/server/api/src/scripts/release.ts` beat for beat (assertBunFloor →
 * parseScope → preflight → build → assert → glob the one artifact the bundler
 * wrote → digest → publish, all-or-nothing, CLI entry behind
 * `import.meta.main`), with one step neither other pipeline has: it BUILDS THE
 * SERVER FIRST and stages it as the Tauri sidecar.
 *
 * Three rules about that server binary, each of which has a failure mode that
 * only shows up on a user's machine:
 *
 * 1. **`compile:release`, never `compile`.** Only the release build embeds the
 *    SPA into `src/generated/embedded-web.ts`. A plain `compile` ships the
 *    tracked stub (`EMBEDDED = false`), and `selectStaticPlugin` then throws at
 *    boot where there is no `apps/server/web/dist` to fall back to.
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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_SERVER_PRODUCT,
  DESKTOP_TARGETS,
  desktopArtifactFileName,
  desktopSidecarFileName,
  RELEASE_MANIFEST_NAME,
  SERVER_SIDECAR_NAME,
  serverArtifactFileName,
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
// By PATH rather than by package name, the way every root script reaches the
// protocol package: this module is a release-pipeline concern with no runtime
// consumer, so it lives in `scripts/` and both desktop pipelines import it —
// which is what keeps the manifest the shards WRITE and the one the publish
// job MERGES one shape.
import {
  buildShardManifest,
  latestManifestName,
  type UpdaterManifest,
  updaterArtifactName,
  updaterPlatformKey,
} from "../../../../../scripts/updater-manifest.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/server/desktop` — the cwd every tauri invocation runs in. */
export const DESKTOP_DIR = resolve(SCRIPT_DIR, "..", "..");
/** The monorepo root — where the nested server build is driven from. */
export const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..", "..");
/** Where `externalBin` expects the staged sidecar. */
export const SIDECAR_DIR = join(DESKTOP_DIR, "src-tauri", "binaries");

/** The scope env var main() parses — exported so tests pin the SAME call shape. */
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
    return { bundles: "app,dmg", dir: "dmg", suffix: ".dmg", intermediates: ["macos", "share"] };
  if (triple === "linux-x64") return { bundles: "deb", dir: "deb", suffix: ".deb", intermediates: [] };
  throw new Error(`no bundler for '${triple}' (known: ${DESKTOP_TARGETS.join(", ")})`);
}

/**
 * `tauri build` argv.
 *
 * `--bundles` is the ENFORCEMENT of the target decision, not a preference:
 * `tauri.conf.json` only sets a default, and the Linux default is
 * deb+rpm+appimage — where the AppImage step downloads `linuxdeploy` at build
 * time and is the single most common failure inside a container.
 *
 * **macOS asks for `app,dmg`, not `dmg`, and that is load-bearing** (measured
 * 2026-09-15, tauri-cli 2.11). With `dmg` alone the bundler warns "configured
 * to create updater artifacts but no updater-enabled targets were built"
 * (`app, appimage, msi, nsis` — `dmg` is not one), emits NO `.app.tar.gz` and
 * then DELETES `bundle/macos/<Product>.app` as an intermediate. The published
 * set is unchanged — `collectArtifact` still globs `dmg/` for the one image,
 * and `macos/` stays a tolerated directory in `assertBundleSet` — but the
 * updater artifact only exists because `app` is in this list.
 *
 * Linux stays `deb`. `deb` is not an updater-enabled target either, so the
 * bundler writes no `.deb.sig` at all and
 * {@link collectUpdaterArtifact} signs the package itself — which is why that
 * fallback is the ordinary Linux path rather than a contingency.
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
  /** Read a text file — the updater `.sig`, whose bytes travel INLINE in `latest.json`. */
  read: (path: string) => Promise<string>;
  /** Write a text file — `latest.<triple>.json`. */
  write: (path: string, text: string) => Promise<void>;
  /** Run a command capturing combined output — what notarytool's verdict is READ from. */
  runCapture: (argv: string[]) => Promise<{ code: number; output: string }>;
  log: (line: string) => void;
}

/**
 * Build the server for `triple` and stage it under the name Tauri expects.
 *
 * The publish dir MUST be absolute: `resolveArtifactsDir()` on the server side
 * calls `resolve()` in the CHILD's cwd (`apps/server/api`), so a relative override
 * would land in `apps/server/api/apps/server/desktop/…` and the build would then fail
 * with "binary not found" pointing at a path that looks right.
 */
export async function stageSidecar(deps: DesktopReleaseDeps, triple: string): Promise<boolean> {
  deps.log(`staging the server sidecar for ${triple}…`);
  const code = await deps.run(["bun", "run", "--cwd", "apps/server/api", "compile:release"], REPO_ROOT, {
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
  // Same rule for the nested build's release manifest: it describes the SERVER
  // release, and this directory is a Tauri build input, not a publish dir.
  // This app writes its OWN manifest into the publish dir at the end of main().
  await deps.remove(join(SIDECAR_DIR, RELEASE_MANIFEST_NAME));
  await deps.move(built, join(SIDECAR_DIR, desktopSidecarFileName(SERVER_SIDECAR_NAME, triple)));
  return true;
}

/**
 * The PLACEHOLDER committed in `tauri.conf.json` where the updater's public
 * key belongs.
 *
 * The real key is the operator's, generated once with
 * `bunx @tauri-apps/cli signer generate -w ~/.tauri/subshell-desktop.key` and shared by
 * BOTH apps (they are one publisher; a public key is the publisher's identity
 * rather than the app's). It is committed rather than injected because it must
 * be compiled into every build — it is what an installed app checks an update
 * against, and an app built without it can never be updated.
 */
export const UPDATER_PUBKEY_PLACEHOLDER = "REPLACE_ME_WITH_THE_SUBSHELL_DESKTOP_MINISIGN_PUBLIC_KEY";

/**
 * Refuse a release cut while the placeholder is still in `tauri.conf.json`.
 *
 * `tauri build` already fails when a pubkey is configured and
 * `TAURI_SIGNING_PRIVATE_KEY` is not set (measured 2026-09-15: "A public key
 * has been found, but no private key"), so the placeholder cannot be SIGNED by
 * accident. What it could do is be signed by a key nobody has the private half
 * of any more — a manifest every installed app refuses, which reads as "there
 * are no updates" and is discovered by nobody. So this refuses first, with the
 * one command that fixes it.
 *
 * @param config - `tauri.conf.json`'s text
 */
export function assertUpdaterPubkey(config: string): void {
  if (config.includes(UPDATER_PUBKEY_PLACEHOLDER)) {
    throw new Error(
      "src-tauri/tauri.conf.json still carries the updater public-key PLACEHOLDER. " +
        "Generate the keypair once with `bunx @tauri-apps/cli signer generate -w ~/.tauri/subshell-desktop.key`, " +
        "commit the .pub contents as plugins.updater.pubkey in BOTH desktop apps, and set the repo secrets " +
        "TAURI_SIGNING_PRIVATE_KEY (the key file's CONTENTS, not a path) and, only if the key has a passphrase, TAURI_SIGNING_PRIVATE_KEY_PASSWORD.",
    );
  }
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
 * the host.
 */
export function hostTarget(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  throw new Error(
    `apps/server/desktop cannot be built on ${platform}-${arch} (buildable here: ${DESKTOP_TARGETS.join(", ")})`,
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
    throw new Error(`apps/server/desktop/package.json has no usable version: '${version}'`);
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
  list: (dir) => readdir(dir),
  read: (path) => Bun.file(path).text(),
  write: async (path, text) => {
    await Bun.write(path, text);
  },
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

  // The nested server build embeds the SPA, so its own preflight needs this —
  // failing here rather than three minutes into a cargo build is the point.
  if (!deps.exists(join(REPO_ROOT, "apps", "server", "web", "dist", "index.html"))) {
    console.error("apps/server/web/dist/index.html is missing. Run `bunx turbo build` first");
    process.exit(1);
  }

  // Before anything is built: the cut needs a real public key, or every
  // installed app would refuse the update this release describes.
  assertUpdaterPubkey(await Bun.file(join(DESKTOP_DIR, "src-tauri", "tauri.conf.json")).text());
  if ((process.env.TAURI_SIGNING_PRIVATE_KEY ?? "") === "") {
    console.error(
      "TAURI_SIGNING_PRIVATE_KEY is not set. It is the key file's CONTENTS, not a path " +
        "(measured 2026-09-15: tauri 2.11 does not read TAURI_SIGNING_PRIVATE_KEY_PATH). " +
        "Without it `tauri build` refuses as soon as it sees the configured public key.",
    );
    process.exit(1);
  }

  await mkdir(SIDECAR_DIR, { recursive: true });
  const artifacts = new Map<string, BuiltArtifact>();
  /** One `latest.<triple>.json` per built target; the publish job merges them. */
  const manifests = new Map<string, UpdaterManifest>();
  try {
    for (const triple of targets) {
      if (!(await stageSidecar(deps, triple))) {
        throw new Error(`the server sidecar for ${triple} failed to build. Nothing published`);
      }
      const bundleRoot = join(DESKTOP_DIR, "src-tauri", "target", "release", "bundle");
      // A previous target's output would otherwise make `assertBundleSet` fail
      // a perfectly good build, and its message name a bundler that did not run.
      await rm(bundleRoot, { recursive: true, force: true });
      if ((await deps.run(["./node_modules/.bin/tauri", ...tauriBuildArgs(triple).slice(1)], DESKTOP_DIR)) !== 0) {
        throw new Error(`tauri build failed for ${triple}. Nothing published`);
      }
      assertBundleSet(await listDirs(bundleRoot), triple);
      const path = await collectArtifact(deps, bundleRoot, triple, version);
      // Tauri signs the image but stops there; the digest below must describe
      // the NOTARIZED, STAPLED bytes, so the chain completes first.
      if (triple === "darwin-arm64" && !(await notarizeAndStapleDmg(path, deps))) {
        throw new Error(`the ${triple} DMG failed notarization/stapling. Nothing published`);
      }
      artifacts.set(triple, { path, digest: await digestFile(path) });

      // The updater half (spec § 8). AFTER the notarization chain, because on
      // macOS the artifact is a tarball of the very `.app` that chain stapled,
      // and BEFORE the publish, because its digest is published like any other
      // asset's. On linux this file IS the `.deb` already in the map, so it is
      // keyed distinctly and `publishArtifacts` reads only the basename —
      // republishing the same bytes under the same name is idempotent.
      const updater = await collectUpdaterArtifact(deps, bundleRoot, triple, version, path);
      // On linux the updater artifact IS the `.deb` already in the map, so
      // adding it a second time would publish the same bytes twice under one
      // name. Only macOS contributes a file of its own.
      if (updater.path !== path) {
        artifacts.set(`${triple}-updater`, { path: updater.path, digest: await digestFile(updater.path) });
      }
      manifests.set(
        triple,
        buildShardManifest({
          version,
          tag: `desktop-server-v${version}`,
          target: triple,
          asset: basename(updater.path),
          signature: updater.signature,
        }),
      );
    }
  } finally {
    // The staged sidecar is a ~110 MB build input, never a leftover. Only the
    // staged files — `binaries/.gitkeep` is tracked, and wiping the directory
    // deleted it on every successful build.
    for (const target of DESKTOP_TARGETS) {
      await rm(join(SIDECAR_DIR, desktopSidecarFileName(SERVER_SIDECAR_NAME, target)), { force: true });
    }
  }

  const dest = resolveReleaseDir();
  await publishArtifacts(artifacts, dest);
  // The fifth asset (spec 2026-09-15 §3.2), after a complete publish: the
  // Updates page reads it to say which desktop version is available. The
  // `assets` map (spec 2026-09-17 D2) is assembled from the digests already
  // computed for the sidecars; the desktop apps' own update path stays on
  // `tauri-plugin-updater`'s per-bundle signature — this manifest is not
  // what the installed apps check.
  const assets: Record<string, string> = {};
  for (const [, a] of artifacts) assets[basename(a.path)] = a.digest;
  const manifest = await writeReleaseManifest(dest, {
    component: "desktop-server",
    version,
    commit: releaseCommit(),
    assets,
  });
  // The sixth: this shard's half of the updater manifest. One platform each,
  // because one shard builds one platform; the publish job merges them into
  // `latest.json`, which is the only document the plugin ever reads.
  for (const [triple, doc] of manifests) {
    await deps.write(join(dest, latestManifestName(triple)), `${JSON.stringify(doc, null, 2)}\n`);
  }
  console.log(`\npublished ${artifacts.size} desktop bundle(s) → ${dest}\n`);
  for (const [triple, a] of artifacts) console.log(`  ${triple.padEnd(24)} ${a.digest}`);
  console.log(`  ${RELEASE_MANIFEST_NAME.padEnd(24)} ${manifest.component} ${manifest.version} @ ${manifest.commit}`);
  for (const triple of manifests.keys()) {
    console.log(`  ${latestManifestName(triple).padEnd(24)} ${updaterPlatformKey(triple)}`);
  }
}

/** Directory names directly under `root`, or [] when it does not exist. */
async function listDirs(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
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
    artifact: join(bundleRoot, dir, desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, triple, version)),
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

/**
 * Where `createUpdaterArtifacts` writes, and what it writes there.
 *
 * MEASURED on 2026-09-15 (tauri-cli 2.11, macOS, `--bundles app`): the
 * bundler emits `bundle/macos/<productName>.app.tar.gz` and, when
 * `TAURI_SIGNING_PRIVATE_KEY` is set, `…​.app.tar.gz.sig` beside it — the `.sig`
 * is APPENDED to the full name rather than replacing the extension, and the
 * tarball's root entry is `<productName>.app/`. The `.app` bundle is finished
 * (signed, and notarized+stapled where credentials are present) BEFORE the
 * tarball step starts, which is the order § 12.5 asks about: the tarball
 * therefore carries whatever the app bundler left behind.
 *
 * Linux is the case this side does NOT assume: the docs name only
 * `AppImage.tar.gz`, and whether a `.deb.sig` appears could not be measured on
 * a Mac. So the `.deb` path looks for the signature and SIGNS the package
 * itself when there is none — which is correct under either answer and costs
 * one `tauri signer sign` when it is not needed.
 */
export function updaterSource(bundleRoot: string, triple: string, product: string, debName: string): string {
  if (triple === "darwin-arm64") return join(bundleRoot, "macos", `${product}.app.tar.gz`);
  if (triple === "linux-x64") return join(bundleRoot, "deb", debName);
  throw new Error(`no updater artifact for '${triple}'`);
}

/**
 * Collect the updater artifact, sign it where the bundler did not, and answer
 * the published path plus the signature's own text.
 *
 * The signature travels INLINE in `latest.json`, which is why it is read here
 * rather than published as a file of its own: the plugin wants the bytes in
 * the document, and a `.sig` beside the artifact would be an asset nothing
 * reads.
 */
export async function collectUpdaterArtifact(
  deps: DesktopReleaseDeps,
  bundleRoot: string,
  triple: string,
  version: string,
  publishedBundle: string,
): Promise<{ path: string; signature: string }> {
  const debName = basename(publishedBundle);
  const source = updaterSource(bundleRoot, triple, DESKTOP_SERVER_PRODUCT, debName);
  if (!deps.exists(source)) {
    throw new Error(`the bundler wrote no updater artifact at ${source} (is bundle.createUpdaterArtifacts on?)`);
  }
  // Linux: sign the .deb ourselves when the bundler did not (§ 12.4). An
  // unsigned updater artifact is one every installed app refuses, so
  // publishing it would be publishing a lie.
  if (!deps.exists(`${source}.sig`)) {
    deps.log(`signing ${basename(source)} (the bundler emitted no .sig)…`);
    // NO KEY ARGUMENT, and that is the whole of what this line has to get
    // right. `tauri signer sign` reads the key from the ENVIRONMENT —
    // `TAURI_SIGNING_PRIVATE_KEY` (which release.yml exports and which is the
    // `-k/--private-key` env binding) or `TAURI_SIGNING_PRIVATE_KEY_PATH` —
    // and `-f` is `--private-key-path`, NOT "read it from stdin". Passing
    // `-f -` alongside the exported variable makes clap refuse before
    // anything is signed: "the argument '--private-key-path' cannot be used
    // with '--private-key'" (measured against this repo's own CLI,
    // 2026-09-15). And a key passed as `-k <value>` would put the private key
    // in argv, where `ps` reads it; the environment is where it belongs.
    const code = await deps.run(["./node_modules/.bin/tauri", "signer", "sign", source], DESKTOP_DIR);
    if (code !== 0) throw new Error(`could not sign ${source}. Nothing published`);
  }
  const signature = (await deps.read(`${source}.sig`)).trim();
  if (signature === "") throw new Error(`${source}.sig is empty. Nothing published`);
  const published = join(
    dirname(source),
    updaterArtifactName(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, triple, version), triple),
  );
  // Linux's updater artifact IS the published bundle, already renamed by
  // `collectArtifact` — there is nothing to move.
  if (source !== published) await deps.move(source, published);
  return { path: published, signature };
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
