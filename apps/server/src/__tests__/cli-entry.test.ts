import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPortListening } from "../cli.js";
import { parseEnvFile } from "../config-env.js";

/**
 * The headline Task C guarantee, checked ACROSS a process boundary: a CLI
 * subcommand through the REAL entry (`bun src/index.ts configure --yes`) must
 * never boot the server — no port bind, no DB open, no config side effects
 * beyond the written file.
 *
 * The in-process gate (bootRequested / isCliEngaged) is NOT what makes this
 * true — it only skips the boot BODY, while Bun still evaluates every later
 * import of the entry, and `@/auth.js` opens SQLite inside better-auth's
 * constructor (Task B audit; reproduced in the Task C spike: an async command
 * left a sentinel ./data/subshell.db behind in the CWD). What makes it true
 * is that init/configure run FULLY SYNCHRONOUSLY and `process.exit` inside
 * the first-imported prelude body, so the boot graph is never evaluated at
 * all. Hence: subprocess (real argv, real env), fresh temp CWD (a stray
 * ./data/subshell.db lands where we can see it), an unused free port pinned
 * in SERVER_PORT (a buggy boot would bind THAT, not 3080), and a temp
 * config dir. Nothing here touches the developer's ~/.config or ./data.
 */

const SERVER_DIR = new URL("../../", import.meta.url).pathname;
const ENTRY = join(SERVER_DIR, "src", "index.ts");
const BUN = process.execPath;
const TIMEOUT = 30_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Clean-env subprocess: the dict REPLACES the parent environment, so the
 * runner's SUBSHELL_TEST_MODE (which would skip the prelude outright) never
 * reaches the child. NODE_ENV=development per the e2e child-env idiom.
 */
async function runCli(args: string[], opts: { cwd: string; env: Record<string, string> }): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [BUN, ENTRY, ...args],
    cwd: opts.cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "development", ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Ephemeral port nobody owns for the duration of one test. */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

/** Every file under `dir` (recursively), relative paths. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe("entry-subprocess CLI: configure must not boot", () => {
  test(
    "configure --yes: exit 0, config.env written, port dark, zero sqlite files in cwd",
    async () => {
      const port = await freePort();
      const cwd = mkdtempSync(join(tmpdir(), `subshell-entry-test-${process.pid}-`));
      const cfg = mkdtempSync(join(tmpdir(), `subshell-entry-cfg-${process.pid}-`));
      const run = await runCli(["configure", "--yes"], {
        cwd,
        env: {
          SUBSHELL_SERVER_CONFIG_DIR: cfg,
          SERVER_PORT: String(port), // the sentinel: a boot would bind THIS
          // RUNNER-TMUX INDEPENDENCE: this suite never depends on the runner
          // having (or lacking) tmux — happy paths pin the documented escape
          // hatch, and the refusal case manufactures a tmux-less PATH below.
          SUBSHELL_SERVER_SKIP_TMUX_CHECK: "1",
        },
      });
      expect(run.code).toBe(0);
      // 1. The file landed, with the documented defaults.
      const text = readFileSync(join(cfg, "config.env"), "utf8");
      const parsed = parseEnvFile(text);
      expect(parsed).toMatchObject({
        SERVER_PORT: "3080", // built-in default — the sentinel env value must NOT leak in
        HOST: "127.0.0.1",
        APP_BASE_URL: "http://localhost:3080",
        DATABASE_PATH: join(cfg, "subshell.db"),
      });
      expect(statSync(join(cfg, "config.env")).mode & 0o777).toBe(0o600);
      // 2. Nothing is listening on the sentinel port (sync LISTEN-table read —
      //    a connect probe would be async, the very hazard this suite is about).
      expect(syncPortListening("127.0.0.1", port)).toBe(false);
      // 3. The CWD stayed pristine — the sentinel sqlite file an imported
      //    `@/auth.js` would have created is absent (and so is anything else).
      expect(walk(cwd)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "init --yes twice: exit 0 both times, the generated secret is byte-stable across processes",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), `subshell-entry-init-${process.pid}-`));
      const cfg = join(cwd, "cfghome", "subshell-server"); // does not exist yet — init creates it
      const env = { SUBSHELL_SERVER_CONFIG_DIR: cfg, SUBSHELL_SERVER_SKIP_TMUX_CHECK: "1" };
      const first = await runCli(["init", "--yes"], { cwd, env });
      expect(first.code).toBe(0);
      const secret = parseEnvFile(readFileSync(join(cfg, "config.env"), "utf8")).BETTER_AUTH_SECRET;
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const second = await runCli(["init", "--yes"], { cwd, env });
      expect(second.code).toBe(0);
      expect(parseEnvFile(readFileSync(join(cfg, "config.env"), "utf8")).BETTER_AUTH_SECRET).toBe(secret);
      // Init itself is pure fs too: no sqlite file appeared in the CWD…
      const dbFiles = walk(cwd).filter((f) => /\.(db|db-wal|db-shm)$/.test(f) && !f.startsWith(`${cfg}/`));
      // …and the only database-named path anywhere is the config.env POINTER,
      // which is a file path in a string, never an opened file.
      expect(dbFiles).toEqual([]);
      expect(statSync(cfg).mode & 0o777).toBe(0o700);
    },
    TIMEOUT,
  );

  test(
    "tmux missing (empty PATH) → refusal, exit 1, config dir stays empty",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), `subshell-entry-notmux-${process.pid}-`));
      const cfg = mkdtempSync(join(tmpdir(), `subshell-entry-notmux-cfg-${process.pid}-`));
      const emptyBin = mkdtempSync(join(tmpdir(), `subshell-entry-emptybin-${process.pid}-`));
      const run = await runCli(["init", "--yes"], {
        cwd,
        // No SKIP env, and a PATH with no tmux in it — the real preflight
        // refuses with the platform hint + escape hatch name.
        env: { SUBSHELL_SERVER_CONFIG_DIR: cfg, PATH: emptyBin },
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/tmux not found/i);
      expect(run.stderr).toContain("SUBSHELL_SERVER_SKIP_TMUX_CHECK=1");
      expect(readdirSync(cfg)).toEqual([]);
    },
    TIMEOUT,
  );
});
