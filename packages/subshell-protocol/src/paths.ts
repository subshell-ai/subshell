/**
 * The binary DISTRIBUTION contract (node side: spec 2026-08-31 §8; server
 * side: plan 2 2026-09-03) — the facts the backend's downloads route and the
 * two release pipelines must agree on, duplicated until this module owned
 * them:
 *
 * 1. {@link NODE_TARGETS} / {@link SERVER_TARGETS} — the closed sets of
 *    served/built platform triples. Drift here means publishing a triple the
 *    route refuses (a 404 on install) or advertising a triple nobody builds.
 * 2. {@link resolveNodeArtifactsDir} — the env ladder deciding WHERE the node
 *    binaries are published/served. Drift means the release publishes to a
 *    directory the running backend never serves — invisible until an install
 *    404s.
 * 3. {@link nodeArtifactFileName} / {@link serverArtifactFileName} — the
 *    artifact NAME each pipeline writes/publishes (and the route reads).
 *    Same failure shape as 2: publish under one name, serve under another.
 *
 * Apps never import each other, so cross-boundary contracts live in
 * `@internal/subshell-protocol` (precedent: WS frames, upload limits). This
 * module stays pure strings (Metro-safe: the mobile app imports the barrel).
 */

/** One {@link NODE_TARGETS} entry. */
export type NodeTarget = (typeof NODE_TARGETS)[number];

/** The closed set of platform triples the `subshell` is published for (spec §8). */
export const NODE_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;

/** One {@link SERVER_TARGETS} entry. */
export type ServerTarget = (typeof SERVER_TARGETS)[number];

/**
 * The closed set of platform triples the `subshell-server` is published for
 * (spec 2026-09-03 §7). Deliberately NARROWER than {@link NODE_TARGETS}: no
 * darwin-x64 (the server targets Apple silicon Macs; an Intel host runs the
 * linux build or the source path).
 */
export const SERVER_TARGETS = ["linux-x64", "linux-arm64", "darwin-arm64"] as const;

/**
 * The file name a built binary is published as and served under:
 * `subshell-<target>` (plus a `.sha256` sidecar written/read alongside it).
 * The agent's release pipeline and the backend's downloads route must agree —
 * drift is a 404 on install. `target` is normally a {@link NodeTarget}; the
 * parameter stays a plain string because the release pipeline's scope
 * override schedules a plain-string subset through the same naming.
 */
export function nodeArtifactFileName(target: string): string {
  return `subshell-${target}`;
}

/**
 * The file name a built `subshell-server` binary is published as:
 * `subshell-server-<target>` (plus a `.sha256` sidecar alongside). Same
 * naming discipline as {@link nodeArtifactFileName}, different product name —
 * the two binaries coexist in one artifacts flow and must never overwrite
 * each other.
 */
export function serverArtifactFileName(target: string): string {
  return `subshell-server-${target}`;
}

/** One {@link DESKTOP_TARGETS} entry. */
export type DesktopTarget = (typeof DESKTOP_TARGETS)[number];

/**
 * The closed set of platform triples `apps/server/desktop` is published for.
 *
 * NARROWER than {@link SERVER_TARGETS}, and for a different reason than the
 * server's own narrowing:
 *
 * - No `linux-arm64`. There is no native arm64 Linux runner, and every
 *   existing arm64 artifact in this repo is cross-built with a `file(1)` magic
 *   check as its only proof. That is defensible for a headless Bun binary and
 *   indefensible for a GTK/WebKit GUI whose characteristic failure is an
 *   INVISIBLE WINDOW — the one thing a magic check cannot see.
 * - No `darwin-x64`, because {@link SERVER_TARGETS} has none. A desktop build
 *   ships a server; a triple with no server to bundle cannot be built at all.
 *
 * Every entry here must therefore also be a {@link ServerTarget}.
 */
export const DESKTOP_TARGETS = ["linux-x64", "darwin-arm64"] as const satisfies readonly ServerTarget[];

/**
 * The Rust target triple for a repo triple.
 *
 * Tauri's `externalBin` names its staged files with the RUST triple, which is
 * a different vocabulary from the one this repo publishes under. Two producers
 * (the release script writing the file, `tauri.conf.json` declaring the stem)
 * and two consumers (the smoke grepping inside the bundle, the app resolving
 * the copy source) have to agree on names whose drift is invisible until
 * `cargo build` says "binary not found".
 *
 * Refuses an unknown triple rather than guessing — the same discipline
 * {@link parseScope} applies to its own scope.
 *
 * @param target - a {@link DesktopTarget}
 * @returns the Rust target triple
 * @throws when `target` is not a desktop target
 */
export function rustTargetTriple(target: string): string {
  const triple = RUST_TARGET_TRIPLES[target as DesktopTarget];
  if (!triple) {
    throw new Error(`no Rust target triple for '${target}' (known: ${DESKTOP_TARGETS.join(", ")})`);
  }
  return triple;
}

const RUST_TARGET_TRIPLES: Record<DesktopTarget, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "darwin-arm64": "aarch64-apple-darwin",
};

/**
 * The in-bundle name of the binary each desktop app ships.
 *
 * Tauri STRIPS the `-<rust triple>` suffix when it copies an `externalBin`, so
 * these are NOT the names of the staged files — see
 * {@link desktopSidecarFileName}. Anything looking for the staged name inside a
 * built bundle finds nothing, 100% of the time.
 *
 * The `-bundled` suffix keeps each distinct from a hand-installed binary of the
 * same lineage: Tauri puts `externalBin` in `/usr/bin` on Debian, so a sidecar
 * named `subshell-server` (or `subshell`) would own a system-wide binary on
 * every user's PATH and collide with any future official package. It is also
 * what keeps "the binary this app SHIPS" and "the binary the user has
 * INSTALLED" two separate files, which the version policy depends on.
 */
export const SERVER_SIDECAR_NAME = "subshell-server-bundled";

/** The in-bundle name of the node agent `apps/client/desktop` ships. */
export const AGENT_SIDECAR_NAME = "subshell-node-bundled";

/**
 * The name a release script STAGES a sidecar under, which carries the Rust
 * triple. Its stripped form is the `sidecarName` it was given.
 *
 * @param sidecarName - {@link SERVER_SIDECAR_NAME} or {@link AGENT_SIDECAR_NAME}
 * @param target - a {@link DesktopTarget}
 */
export function desktopSidecarFileName(sidecarName: string, target: string): string {
  return `${sidecarName}-${rustTargetTriple(target)}`;
}

/**
 * The macOS/Debian product name of each desktop app — the name a user sees.
 *
 * Tauri derives BOTH the `.app` directory name and the `.deb` file name from
 * `productName`, so this is what the bundler EMITS: `Subshell Server.app` and
 * `Subshell Server_<version>_<arch>.deb`, spaces and all. Measured against a
 * real bundle rather than assumed: Tauri sanitizes in exactly ONE place, the
 * Debian `Package:` control field, which it kebab-cases to `subshell-server`.
 * The FILE name it never touches.
 *
 * That is deliberately NOT what this repo publishes — see
 * {@link desktopArtifactFileName} — and it is why the pipelines GLOB the bundle
 * directory for the one artifact that appeared and rename it. A published name
 * containing a space would be hostile in a download URL and in every shell that
 * handles it, and a PREDICTED name could not have survived the space at all.
 *
 * Must equal `productName` in each app's `tauri.conf.json` (pinned by test in
 * both apps): that is the string the release script tars and the smoke looks
 * for inside the tarball.
 */
export const DESKTOP_SERVER_PRODUCT = "Subshell Server";

/** The product name of `apps/client/desktop` — the node agent's GUI. */
export const DESKTOP_CLIENT_PRODUCT = "Subshell Client";

/**
 * Appended to every published desktop artifact name, so a downloaded file says
 * which of the two things it is — the app, or the CLI binary it wraps.
 *
 * Not part of `productName`: see {@link desktopArtifactFileName}.
 */
export const DESKTOP_SUFFIX = "Desktop";

/**
 * The name this repo PUBLISHES a desktop artifact under — chosen here, never
 * read off the bundler's output.
 *
 * These are download URLs and shell arguments, so they are space-free: the
 * product name's whitespace becomes `-`, and the Debian name is lowercased on
 * top of that (a `.deb` file name is conventionally the package name, which
 * Debian requires to be lowercase).
 *
 * **Every name carries {@link DESKTOP_SUFFIX}**, because the CLI artifacts ship
 * from the same repo under names that would otherwise be mistaken for these:
 * the server CLI publishes `subshell-server-<triple>` and the agent
 * `subshell-<triple>`. In a downloads folder `subshell-server_0.5.0_amd64.deb`
 * next to `subshell-server-darwin-arm64` says nothing about which is the app,
 * so `Subshell Server` publishes as `Subshell-Server-Desktop.app.tar.gz` and
 * `subshell-server-desktop_<version>_amd64.deb`.
 *
 * The suffix is on the FILE NAME only. `productName` stays `Subshell Server`,
 * so the installed app, the window title and the menu bar are unchanged — and
 * so, deliberately, is the Debian `Package:` field, which Tauri derives from
 * `productName` and which is therefore still `subshell-server`. That is a
 * latent collision with a future server-CLI `.deb`: two packages cannot share
 * a name, and installing one would replace the other. The `/usr/bin` paths do
 * NOT collide (that is what the `-bundled` sidecar suffix is for), so this is
 * package identity only, and the lever if it ever matters is `productName`.
 *
 * The `.app` INSIDE the tarball keeps its real, spaced name — that is what the
 * user installs and what the bundle identifier belongs to — so anything
 * handling that path has to quote it.
 *
 * macOS ships a tarball rather than a DMG, which Tauri signs but neither
 * notarizes nor staples.
 *
 * @param product - {@link DESKTOP_SERVER_PRODUCT} or {@link DESKTOP_CLIENT_PRODUCT}
 * @param target - a {@link DesktopTarget}
 * @param version - the app version, for the Debian file name
 */
export function desktopArtifactFileName(product: string, target: string, version: string): string {
  const slug = `${product.trim().replace(/\s+/g, "-")}-${DESKTOP_SUFFIX}`;
  if (target === "darwin-arm64") return `${slug}.app.tar.gz`;
  if (target === "linux-x64") return `${slug.toLowerCase()}_${version}_amd64.deb`;
  throw new Error(`no desktop artifact name for '${target}' (known: ${DESKTOP_TARGETS.join(", ")})`);
}

/** Fallback SQLite path when `DATABASE_PATH` is unset — the data dir derives from it. */
export const DEFAULT_DATABASE_PATH = "./data/subshell.db";

/** The three env vars that steer the artifacts location (raw strings, as found on `process.env`). */
export interface NodeArtifactsEnv {
  /** Publish/serve directory override — wins outright when non-empty. */
  SUBSHELL_NODE_ARTIFACTS_DIR?: string | undefined;
  /** Subshell-data root override — `<it>/node-artifacts` when set. */
  SUBSHELL_SERVER_DATA_DIR?: string | undefined;
  /** SQLite path the data-dir default derives from (default `./data/subshell.db`). */
  DATABASE_PATH?: string | undefined;
}

/**
 * The database file's directory, or `./data` when the path is not file-backed
 * (an in-memory database or a SQLite URI has no meaningful dirname).
 * @param env - raw environment values (only `DATABASE_PATH` is read)
 */
export function defaultSubshellServerDataDir(env: NodeArtifactsEnv): string {
  const raw = env.DATABASE_PATH || DEFAULT_DATABASE_PATH;
  if (raw.startsWith("file:") || raw.includes(":memory:") || !raw.includes("/")) return "./data";
  return raw.slice(0, Math.max(0, raw.lastIndexOf("/"))) || ".";
}

/**
 * Resolve where `subshell-<target>` binaries are published to / served
 * from, UN-normalized (callers `resolve()` it against their own cwd — the
 * apps deliberately disagree on cwd, the ENV ladder is what must not drift).
 * Ladder: `SUBSHELL_NODE_ARTIFACTS_DIR` → `<SUBSHELL_SERVER_DATA_DIR>/node-artifacts` →
 * `<defaultSubshellServerDataDir>/node-artifacts`. Empty strings count as unset.
 * @param env - raw environment values
 */
export function resolveNodeArtifactsDir(env: NodeArtifactsEnv): string {
  const explicit = env.SUBSHELL_NODE_ARTIFACTS_DIR;
  if (explicit) return explicit;
  const subshell = (env.SUBSHELL_SERVER_DATA_DIR || defaultSubshellServerDataDir(env)).replace(/\/+$/, "");
  // Plain concat, NOT join(): join normalizes "./data" to "data", and this
  // function's output is a CONTRACT STRING callers resolve themselves — the
  // relative-marker spelling must survive untouched.
  return `${subshell}/node-artifacts`;
}
