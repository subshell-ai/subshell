import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The import-purity invariant (spec 2026-09-03 §2), pinned as a TEST rather
 * than an argument: evaluating `@/auth.js` must perform NO filesystem IO.
 * The historical offender was twofold — the `betterAuth()` constructor
 * (opens SQLite) and the `database: authDatabase()` entry inside the
 * `AUTH_OPTIONS` literal (also opens SQLite, at module evaluation) — so
 * neither may survive.
 *
 * Checked ACROSS a process boundary with a clean env (no SUBSHELL_TEST_MODE,
 * which would redirect DATABASE_PATH to the per-process temp file and hide
 * the litter — the same subprocess idiom as cli-entry.test.ts). The probe
 * lives IN the temp CWD and imports the real module by absolute path (the
 * `@/` aliases resolve from the imported file's own tsconfig, not the cwd);
 * with no DATABASE_PATH set, the default is the cwd-relative
 * `data/subshell.db`, so ANY import-time open must land where we can see it.
 */

const SERVER_DIR = new URL("../../", import.meta.url).pathname;
const AUTH_TS = join(SERVER_DIR, "src", "auth.ts");
const BUN = process.execPath;
const TIMEOUT = 30_000;

/** Every file under `dir` (recursively), absolute paths. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe("@/auth.js import purity", () => {
  test(
    "evaluating auth.ts never calls getAuth(): exit 0 and zero sqlite files in the CWD",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), `subshell-auth-purity-${process.pid}-`));
      const probe = join(cwd, "probe.ts");
      writeFileSync(probe, `import ${JSON.stringify(AUTH_TS)};\nconsole.log("auth-module-evaluated");\n`);
      const proc = Bun.spawn({
        cmd: [BUN, probe],
        cwd,
        // Clean env REPLACES the parent's — no SUBSHELL_TEST_MODE, no
        // DATABASE_PATH: the default cwd-relative path must be live for the
        // litter sentinel to mean anything.
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "development" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // The graph evaluated (a resolution/boot error would surface here, not
      // as a passing no-litter run).
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain("auth-module-evaluated");
      expect(walk(cwd).filter((f) => /\.(db|db-wal|db-shm)$/.test(f))).toEqual([]);
    },
    TIMEOUT,
  );
});
