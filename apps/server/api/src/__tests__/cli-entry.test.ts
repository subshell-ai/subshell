import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPortListening } from "../commands/status.js";
import { parseEnvFile } from "../config-env.js";
import { sqliteLitter, walkTree } from "../test-helpers/fs-litter.js";

/**
 * The headline Task C guarantee, checked ACROSS a process boundary: a CLI
 * subcommand through the REAL entry (`bun src/index.ts configure --yes`) must
 * never boot the server — no port bind, no DB open, no config side effects
 * beyond the written file.
 *
 * What makes this true (post-single-binary-MCP, spec 2026-09-03): the entry
 * graph is IO-free AT IMPORT by contract (lazy `getAuth()`, lazified default
 * launcher — pinned by the import-purity tests), and the `isCliEngaged()` boot
 * gate flipped synchronously at subcommand recognition keeps even a SUSPENDED
 * command (`mcp`) from booting the server underneath it. (Historical: the
 * eager better-auth build opened SQLite at import — the Task C spike's stray
 * ./data/subshell.db — which is why sync-exit was once load-bearing for the
 * quick commands. It no longer is; these assertions survive because purity
 * plus the gate carry the load for every command, sync or long-running.)
 * Hence: subprocess (real argv, real env), fresh temp CWD (a stray
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

/**
 * Asserts a clean exit, and on failure SAYS WHY.
 *
 * A bare `expect(code).toBe(0)` reports "expected 0, received 1" and throws
 * the subprocess's stderr away — which is where the reason always is. That
 * cost a long investigation once already: `@internal/server#test` had a turbo
 * override that dropped `^build`, so a concurrent dependency rebuild could
 * wipe a dependency dist mid-run and the child died on
 * `Cannot find module '@internal/subshell-protocol'`. The message was right
 * there and invisible.
 */
function expectCleanExit(run: RunResult, what: string): void {
  if (run.code === 0) return;
  throw new Error(
    `${what} exited ${run.code}\n--- stderr ---\n${run.stderr.trim() || "(empty)"}\n--- stdout ---\n${run.stdout.trim() || "(empty)"}`,
  );
}

/** Ephemeral port nobody owns for the duration of one test. */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

describe("entry-subprocess BOOT: config.env reaches the RUNNING process", () => {
  // The launchd crash-loop class, reproduced without launchd. ESM evaluates
  // the whole import graph before any module body runs, so a loadConfigEnv()
  // call in cli-bootstrap's body landed AFTER constants.ts had already read
  // process.env — silently no-op'ing the entire config.env layer on every
  // non-systemd boot (measured 2026-09-07: the mac-mini service resolved
  // `./data/subshell.db` against launchd's cwd `/` and crash-looped on
  // `/data`). No CLI subcommand can prove this: `status` reports the layer
  // from `resolveConfig()`, which reads the FILE regardless of whether the
  // boot path applies it. Only a bare boot answers the real question.
  test(
    "boots with config.env's DATABASE_PATH, and never touches the ./data default",
    async () => {
      const port = await freePort();
      const cwd = mkdtempSync(join(tmpdir(), `subshell-boot-test-${process.pid}-`));
      const cfg = mkdtempSync(join(tmpdir(), `subshell-boot-cfg-${process.pid}-`));
      const db = join(cfg, "boot.db");
      writeFileSync(
        join(cfg, "config.env"),
        `SERVER_PORT=${port}\nDATABASE_PATH=${db}\nBETTER_AUTH_SECRET=boot-test-secret-long-enough-for-dev\n`,
        { mode: 0o600 },
      );
      const proc = Bun.spawn({
        cmd: [BUN, ENTRY],
        cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          NODE_ENV: "development",
          SUBSHELL_SERVER_CONFIG_DIR: cfg,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        // Boot runs its migrations against that exact path within moments;
        // a regression would die (no /data to write in — here it would
        // create ./data under the temp cwd, asserted absent below) or open
        // the wrong DB.
        const deadline = Date.now() + TIMEOUT;
        while (!existsSync(db)) {
          if (proc.exitCode !== null) {
            const err = await new Response(proc.stderr).text();
            throw new Error(`boot exited ${proc.exitCode} without opening ${db}\n--- stderr ---\n${err}`);
          }
          if (Date.now() > deadline) throw new Error(`boot did not open ${db} within ${TIMEOUT}ms`);
          await Bun.sleep(50);
        }
        // The default-relative litter the launchd bug produced is absent.
        expect(sqliteLitter(cwd)).toEqual([]);
      } finally {
        proc.kill();
      }
    },
    TIMEOUT,
  );
});

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
      expectCleanExit(run, "configure --yes");
      // 1. The file landed, with the documented defaults.
      const text = readFileSync(join(cfg, "config.env"), "utf8");
      const parsed = parseEnvFile(text);
      expect(parsed).toMatchObject({
        SERVER_PORT: "3080", // built-in default — the sentinel env value must NOT leak in
        HOST: "0.0.0.0", // the LAN-bind default (loopback is an explicit opt-out)
        APP_BASE_URL: "http://localhost:3080",
        DATABASE_PATH: join(cfg, "subshell.db"),
      });
      expect(statSync(join(cfg, "config.env")).mode & 0o777).toBe(0o600);
      // 2. Nothing is listening on the sentinel port (sync LISTEN-table read —
      //    a connect probe would be async, the very hazard this suite is about).
      expect(syncPortListening("127.0.0.1", port)).toBe(false);
      // 3. The CWD stayed pristine — the sentinel sqlite file an imported
      //    `@/auth.js` would have created is absent (and so is anything else).
      expect(walkTree(cwd)).toEqual([]);
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
      expectCleanExit(first, "init --yes (first)");
      const secret = parseEnvFile(readFileSync(join(cfg, "config.env"), "utf8")).BETTER_AUTH_SECRET;
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const second = await runCli(["init", "--yes"], { cwd, env });
      expectCleanExit(second, "init --yes (second)");
      expect(parseEnvFile(readFileSync(join(cfg, "config.env"), "utf8")).BETTER_AUTH_SECRET).toBe(secret);
      // Init itself is pure fs too: no sqlite file appeared in the CWD…
      const dbFiles = sqliteLitter(cwd).filter((f) => !f.startsWith(`${cfg}/`));
      // …and the only database-named path anywhere is the config.env POINTER,
      // which is a file path in a string, never an opened file.
      expect(dbFiles).toEqual([]);
      expect(statSync(cfg).mode & 0o777).toBe(0o700);
    },
    TIMEOUT,
  );

  test(
    "status with a malformed SUBSHELL_MCP_ARGS: exit 0, the error line, and NO db litter",
    async () => {
      // status gained an mcp-entrypoint probe reading SUBSHELL_MCP_ARGS; if a
      // malformed value threw from the "non-throwing" probe, the sync-exit
      // contract would break exactly the way the module header documents:
      // the unhandled rejection delays exit, the entry graph evaluates in
      // the gap, and better-auth's import opens ./data/subshell.db HERE.
      const cwd = mkdtempSync(join(tmpdir(), `subshell-entry-status-${process.pid}-`));
      const cfg = mkdtempSync(join(tmpdir(), `subshell-entry-status-cfg-${process.pid}-`));
      const port = await freePort();
      const run = await runCli(["status"], {
        cwd,
        env: {
          SUBSHELL_SERVER_CONFIG_DIR: cfg,
          SERVER_PORT: String(port), // a buggy boot would bind THIS, not 3080
          SUBSHELL_MCP_COMMAND: "/opt/custom/mcp",
          SUBSHELL_MCP_ARGS: "mcp", // operator typo: not the JSON array the contract wants
        },
      });
      expectCleanExit(run, "status");
      expect(run.stdout).toContain("SUBSHELL_MCP_ARGS");
      expect(sqliteLitter(cwd)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "mcp without pane env: clean contract refusal, no db litter, no port bind",
    async () => {
      // The import-purity regression net (spec 2026-09-03 §1): `mcp` is a
      // long-running command — it suspends by nature. Safety now rests on the
      // graph being IO-free at import (lazy getAuth), NOT on sync-exit. This
      // must hold ACROSS the real entry: no ./data/subshell.db, and the
      // pinned SERVER_PORT never gains a listener.
      const cwd = mkdtempSync(join(tmpdir(), `subshell-entry-mcp-${process.pid}-`));
      const port = await freePort();
      const run = await runCli(["mcp"], {
        cwd,
        env: {
          SERVER_PORT: String(port),
          SUBSHELL_SERVER_CONFIG_DIR: join(cwd, "cfg"),
          PATH: "/usr/bin:/bin",
        },
      });
      expect(run.code).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain("SUBSHELL_API_KEY");
      // The header promise, ACTUALLY asserted: the pinned port stayed dark
      // (sync LISTEN-table read — a connect probe would be async, the very
      // hazard this suite pins), and the CWD shows no boot litter — neither a
      // `data/` directory (a boot mkdirs it even before the first file lands)
      // nor any sqlite artifact.
      expect(syncPortListening("127.0.0.1", port)).toBe(false);
      expect(readdirSync(cwd)).not.toContain("data");
      expect(sqliteLitter(cwd)).toEqual([]);
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
