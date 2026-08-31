import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BinaryLookupOptions {
  /** Environment to inspect (defaults to process.env; injectable for tests) */
  env?: Record<string, string | undefined>;
  /** Override for PATH lookup */
  pathEntries?: string[];
}

/**
 * Cross-platform-ish binary lookup:
 *   1. `env[ENV_NAME]` (explicit override, e.g. CLAUDE_PATH)
 *   2. `which`-style scan of PATH entries
 *   3. A couple of well-known install locations (resolved against HOME)
 */
export async function findBinary(name: string, envName: string, knownPaths: string[]): Promise<string | null> {
  const options: BinaryLookupOptions = {
    env: process.env,
    pathEntries: (process.env.PATH ?? "").split(":"),
  };
  return findBinaryWithOptions(name, envName, knownPaths, options);
}

export async function findBinaryWithOptions(
  name: string,
  envName: string,
  knownPaths: string[],
  options: BinaryLookupOptions,
): Promise<string | null> {
  const env = options.env ?? process.env;
  const explicit = env[envName];
  if (explicit) {
    if (await isExecutable(explicit)) return explicit;
    return null;
  }

  const pathEntries = options.pathEntries ?? (env.PATH ?? "").split(":");
  for (const dir of pathEntries) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }

  const home = env.HOME ?? homedir();
  for (const rel of knownPaths) {
    const candidate = join(home, rel);
    if (await isExecutable(candidate)) return candidate;
  }

  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const stat = await Bun.file(path).stat();
  return stat.isFile() && (stat.mode & 0o111) !== 0;
}
