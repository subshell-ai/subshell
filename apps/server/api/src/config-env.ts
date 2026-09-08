import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The `config.env` layer of the server's config precedence ladder
 * (spec 2026-09-03, plan 2): **process env > config.env > `.env`-via-dotenvx
 * (already in place) > built-in defaults**.
 *
 * Deliberately dependency-light — node builtins only. Nothing in this module
 * runs at import time: `loadConfigEnv()` is a no-arg action the boot entry
 * takes EXPLICITLY as its first act (imported first by `cli-bootstrap.ts`),
 * so merely importing this file (e.g. from a test) reads no user config and
 * mutates nothing.
 */

/**
 * The server's config home: `SUBSHELL_SERVER_CONFIG_DIR` when set (the
 * documented test/CI override), else `~/.config/subshell-server` — the same
 * home the deployment already treats as the instance's data dir.
 *
 * @returns Absolute path to the config directory (need not exist yet)
 */
export function serverConfigDir(): string {
  return process.env.SUBSHELL_SERVER_CONFIG_DIR ?? join(homedir(), ".config", "subshell-server");
}

/**
 * Path of the `config.env` file (`<serverConfigDir>/config.env`). Existence is
 * not guaranteed — a missing file is the silent no-op case (see
 * {@link loadConfigEnv}).
 *
 * @returns Absolute path to the config.env file for this process
 */
export function configEnvPath(): string {
  return join(serverConfigDir(), "config.env");
}

/**
 * Parses a KEY=VALUE file. Grammar (intentionally minimal — systemd's
 * EnvironmentFile is the reference behaviour, which keeps quotes LITERALLY —
 * so quoted values are refused rather than silently mis-read):
 *
 * - blank/whitespace-only lines and `#comment` lines are skipped;
 * - everything before the FIRST `=` is the key, everything after it the value
 *   (both trimmed); a line with no `=` — or an empty key — is ignored as
 *   malformed;
 * - a value wrapped in matching single OR double quotes loses exactly that
 *   one outer pair (unbalanced or interior quotes are kept verbatim);
 * - no multiline/continued values — one entry per line.
 *
 * @param text - Raw file contents
 * @returns The parsed pairs (last occurrence of a key wins)
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no '=' at all, or an empty key → malformed, ignored
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    values[key] = value;
  }
  return values;
}

/** A read-only snapshot of the config.env layer for the current environment. */
export interface ResolvedConfigEnv {
  /** The config.env path a load would read ({@link configEnvPath}). */
  path: string;
  /** True when the file exists and parsed cleanly. */
  exists: boolean;
  /** Raw parsed pairs from the file (empty when absent). */
  values: Record<string, string>;
  /**
   * Resolves one key through the boot-time precedence — `process.env` wins,
   * then config.env, then `undefined` (the caller's built-in default).
   * Mirrors what `loadConfigEnv()`'s SETDEFAULT pass leaves behind, WITHOUT
   * mutating `process.env`, so `status` can show the same view the boot will
   * see.
   *
   * @param key - Environment variable name
   */
  get(key: string): string | undefined;
}

/**
 * Pure resolution of the config.env layer: reads the file (ENOENT → absent),
 * throws with the path on any other read failure, and folds in the
 * process-env-wins precedence in {@link ResolvedConfigEnv.get}. Never mutates
 * `process.env` — shared by {@link loadConfigEnv} (which applies it) and the
 * CLI `status` command (which only reports it).
 */
export function resolveConfig(): ResolvedConfigEnv {
  const path = configEnvPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, exists: false, values: {}, get: (key) => process.env[key] };
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`subshell-server: cannot read config file ${path}: ${reason}`);
  }
  const values = parseEnvFile(text);
  return {
    path,
    exists: true,
    values,
    get: (key) => process.env[key] ?? values[key],
  };
}

/**
 * Applies the config.env layer to `process.env` with SETDEFAULT semantics —
 * a key already present (real environment, incl. anything `.env`-via-dotenvx
 * filled) is NEVER overwritten; that is what makes the ladder
 * `process env > config.env > .env > defaults` hold, PROVIDED this runs
 * before the dotenvx call in `constants.ts` (the boot entry's first-imported
 * `cli-bootstrap.ts` is what guarantees that ordering).
 *
 * A missing file is silent (`false`); an unreadable one throws with the path.
 *
 * @returns True when the file existed and the setdefault pass ran
 */
export function loadConfigEnv(): boolean {
  const { exists, values } = resolveConfig();
  if (!exists) return false;
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}
