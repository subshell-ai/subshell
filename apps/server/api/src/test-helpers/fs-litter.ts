import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Filesystem-litter sentinels for the subprocess purity suites
 * (`cli-entry.test.ts`, `auth-import-purity.test.ts`). Those suites prove the
 * entry graph opens nothing at import by running a real child in an empty
 * temp CWD and asserting no sqlite files appeared; the walk and the sentinel
 * set used to be hand-copied per suite (four call sites, two JSDocs already
 * in disagreement), which is exactly how a purity proof quietly weakens.
 */

/**
 * Every file under `dir`, recursively, as ABSOLUTE paths.
 * @param dir - the directory to walk
 */
export function walkTree(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTree(p));
    else out.push(p);
  }
  return out;
}

/**
 * The sqlite sentinel set: main file + WAL sidecars. A non-empty answer means
 * something opened (or created) a database under `dir` — the litter the
 * import-purity invariant forbids.
 * @param dir - the directory to sweep
 */
export function sqliteLitter(dir: string): string[] {
  return walkTree(dir).filter((f) => /\.(db|db-wal|db-shm)$/.test(f));
}
