/**
 * The node DISTRIBUTION contract (spec 2026-08-31 §8) — the two facts the
 * backend's downloads route and the agent's release pipeline must agree on,
 * duplicated until this module owned them:
 *
 * 1. {@link NODE_TARGETS} — the closed set of served/built platform triples.
 *    Drift here means publishing a triple the route refuses (a 404 on install)
 *    or advertising a triple nobody builds.
 * 2. {@link resolveNodeArtifactsDir} — the env ladder deciding WHERE those
 *    binaries are published/served. Drift means the release publishes to a
 *    directory the running backend never serves — invisible until an install
 *    404s.
 *
 * Apps never import each other, so cross-boundary contracts live in
 * `@internal/session-protocol` (precedent: WS frames, upload limits).
 */

/** One {@link NODE_TARGETS} entry. */
export type NodeTarget = (typeof NODE_TARGETS)[number];

/** The closed set of platform triples the `subshell` is published for (spec §8). */
export const NODE_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;

/** The three env vars that steer the artifacts location (raw strings, as found on `process.env`). */
export interface NodeArtifactsEnv {
  /** Publish/serve directory override — wins outright when non-empty. */
  SUBSHELL_NODE_ARTIFACTS_DIR?: string | undefined;
  /** Session-data root override — `<it>/node-artifacts` when set. */
  SESSION_DATA_DIR?: string | undefined;
  /** SQLite path the data-dir default derives from (default `./data/subshell.db`). */
  DATABASE_PATH?: string | undefined;
}

/**
 * The database file's directory, or `./data` when the path is not file-backed
 * (an in-memory database or a SQLite URI has no meaningful dirname).
 * @param env - raw environment values (only `DATABASE_PATH` is read)
 */
export function defaultSessionDataDir(env: NodeArtifactsEnv): string {
  const raw = env.DATABASE_PATH || "./data/subshell.db";
  if (raw.startsWith("file:") || raw.includes(":memory:") || !raw.includes("/")) return "./data";
  return raw.slice(0, Math.max(0, raw.lastIndexOf("/"))) || ".";
}

/**
 * Resolve where `subshell-<target>` binaries are published to / served
 * from, UN-normalized (callers `resolve()` it against their own cwd — the
 * apps deliberately disagree on cwd, the ENV ladder is what must not drift).
 * Ladder: `SUBSHELL_NODE_ARTIFACTS_DIR` → `<SESSION_DATA_DIR>/node-artifacts` →
 * `<defaultSessionDataDir>/node-artifacts`. Empty strings count as unset.
 * @param env - raw environment values
 */
export function resolveNodeArtifactsDir(env: NodeArtifactsEnv): string {
  const explicit = env.SUBSHELL_NODE_ARTIFACTS_DIR;
  if (explicit) return explicit;
  const session = (env.SESSION_DATA_DIR || defaultSessionDataDir(env)).replace(/\/+$/, "");
  // Plain concat, NOT join(): join normalizes "./data" to "data", and this
  // function's output is a CONTRACT STRING callers resolve themselves — the
  // relative-marker spelling must survive untouched.
  return `${session}/node-artifacts`;
}
