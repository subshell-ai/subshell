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

/**
 * The file name the server release builds its MCP companion as:
 * `subshell-mcp-<target>`. The server's own resolver (apps/server
 * `mcp-resolve.ts`) finds it as the `subshell-mcp` sibling of the installed
 * executable, so an operator installs BOTH artifacts of a triple side by side
 * (triple suffix dropped) and a server-only host self-resolves its MCP
 * entrypoint. Same digest/sidecar discipline as {@link serverArtifactFileName}.
 */
export function serverMcpArtifactFileName(target: string): string {
  return `subshell-mcp-${target}`;
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
