import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "../../config-env.js";
import { runInit } from "../init.js";
import { HOMEBREW_INSTALL_URL } from "../tmux-install.js";
import { makeDeps } from "./test-deps.js";

/**
 * `runInit` unit suite: secret bootstrap (generate-once, carry-forward,
 * env-persist), then the configure flow with flag pass-through. Same injected
 * seams as configure.test.ts — no process.env, no real HOME.
 */

const envFile = (dir: string): string => join(dir, "config.env");
const readCfg = (dir: string): Record<string, string> => parseEnvFile(readFileSync(envFile(dir), "utf8"));

describe("runInit — first run", () => {
  test("creates a 0700 config home, generates the secret, then lands the configure defaults", async () => {
    const base = mkdtempSync(join(tmpdir(), `subshell-init-test-${process.pid}-`));
    const fresh = join(base, "deep", "home"); // does not exist yet — init must mkdir -p it
    const { deps, out } = makeDeps({ configDir: fresh });
    expect(await runInit({ yes: true }, deps)).toBe(0);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    const cfg = readCfg(fresh);
    // 32 random bytes as base64url = 43 chars, URL-safe alphabet, no padding.
    expect(cfg.BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cfg.SERVER_PORT).toBe("3080");
    expect(cfg.DATABASE_PATH).toBe(join(fresh, "subshell.db"));
    expect(statSync(envFile(fresh)).mode & 0o777).toBe(0o600);
    expect(out.join("\n")).toMatch(/generated/i);
  });

  test("flags pass through to the configure flow (base-url default follows --port)", async () => {
    const { deps, dir } = makeDeps();
    expect(await runInit({ yes: true, port: "9001" }, deps)).toBe(0);
    const cfg = readCfg(dir);
    expect(cfg.SERVER_PORT).toBe("9001");
    expect(cfg.APP_BASE_URL).toBe("http://localhost:9001");
  });
});

describe("runInit — idempotence", () => {
  test("a second init does NOT regenerate or change the secret (file byte-stable)", async () => {
    const { deps, dir } = makeDeps();
    expect(await runInit({ yes: true }, deps)).toBe(0);
    const before = readFileSync(envFile(dir), "utf8");
    expect(await runInit({ yes: true }, deps)).toBe(0);
    const after = readFileSync(envFile(dir), "utf8");
    expect(after).toBe(before); // same secret, same order, no timestamp churn
  });

  test("a secret already in config.env is left untouched even when the file predates init", async () => {
    const { deps, dir, out } = makeDeps();
    writeFileSync(envFile(dir), "BETTER_AUTH_SECRET=legacy-secret\nSERVER_PORT=2222\n", { mode: 0o600 });
    expect(await runInit({ yes: true }, deps)).toBe(0);
    const cfg = readCfg(dir);
    expect(cfg.BETTER_AUTH_SECRET).toBe("legacy-secret");
    expect(cfg.SERVER_PORT).toBe("2222"); // the flow rewrites its keys, from the file's own values
    expect(out.join("\n")).toMatch(/left untouched/i);
  });

  test("a secret only in the environment is persisted to config.env, not regenerated", async () => {
    const { deps, dir } = makeDeps({ env: { BETTER_AUTH_SECRET: "from-the-environment" } });
    expect(await runInit({ yes: true }, deps)).toBe(0);
    expect(readCfg(dir).BETTER_AUTH_SECRET).toBe("from-the-environment");
  });

  test("an empty-string secret in the file counts as absent and gets replaced", async () => {
    const { deps, dir } = makeDeps();
    writeFileSync(envFile(dir), "BETTER_AUTH_SECRET=\n", { mode: 0o600 });
    expect(await runInit({ yes: true }, deps)).toBe(0);
    expect(readCfg(dir).BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("runInit — tmux preflight", () => {
  test("refuses before ANY write: no config home, no secret, no config.env", async () => {
    const fresh = join(mkdtempSync(join(tmpdir(), `subshell-init-nix-${process.pid}-`)), "home");
    const { deps, err } = makeDeps({ configDir: fresh, which: () => null });
    expect(await runInit({ yes: true }, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/tmux not found/i);
    expect(statSync(fresh, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("the skip env is honored", async () => {
    const { deps, dir } = makeDeps({ which: () => null, env: { SUBSHELL_SERVER_SKIP_TMUX_CHECK: "1" } });
    expect(await runInit({ yes: true }, deps)).toBe(0);
    expect(readCfg(dir).BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("interactive offer + install success → init CONTINUES (secret + config written, no rerun)", async () => {
    let installed = false;
    const { deps, dir, out, prompts } = makeDeps({
      isTTY: true,
      platform: "linux",
      which: (n) => (n === "apt-get" ? "/usr/bin/apt-get" : n === "tmux" && installed ? "/usr/bin/tmux" : null),
      spawnInstall: () => {
        installed = true;
        return 0;
      },
      answers: ["y", "", "", "", "", ""],
      // The service question rides at the end of the same interactive run.
      confirmations: [true],
    });
    expect(await runInit({}, deps)).toBe(0);
    expect(prompts[0]?.[0]).toMatch(/Install tmux now with apt-get\?/i);
    expect(out.join("\n")).toMatch(/tmux installed/i);
    // Continued all the way through: BOTH the preflight-then-write path ran.
    expect(readCfg(dir).BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readCfg(dir).SERVER_PORT).toBe("3080");
  });

  // Operator ruling 2026-09-26: `--yes` means EVERYTHING. The old rule
  // ("--yes never offers, system-package installs are never the consequence
  // of a flag") inverted for `init`/`configure`: `--yes` now RUNS the
  // installer it would have offered, and a non-interactive run WITHOUT
  // `--yes` is the silent refusal it always was, now with the remedy named.
  test("--yes installs tmux directly through the same installer seam (shared gate with configure)", async () => {
    let installed = false;
    const spawned: (readonly string[])[] = [];
    const { deps, prompts, out, dir } = makeDeps({
      isTTY: true,
      platform: "linux",
      which: (n) => (n === "apt-get" ? "/usr/bin/apt-get" : n === "tmux" && installed ? "/usr/bin/tmux" : null),
      spawnInstall: (argv) => {
        spawned.push(argv);
        installed = true;
        return 0;
      },
    });
    expect(await runInit({ yes: true }, deps)).toBe(0);
    expect(prompts).toEqual([]); // nobody is asked; --yes IS the answer
    expect(spawned).toEqual([["sudo", "apt-get", "install", "-y", "tmux"]]);
    expect(out.join("\n")).toMatch(/installing tmux via apt-get/);
    expect(readCfg(dir).BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("non-interactive without --yes: refusal adds the terminal remedy when an installer exists", async () => {
    const { deps, err } = makeDeps({
      isTTY: false,
      platform: "linux",
      which: (n) => (n === "apt-get" ? "/usr/bin/apt-get" : null),
    });
    expect(await runInit({}, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/tmux not found/i);
    expect(err.join("\n")).toContain("tmux not installed; re-run init in a terminal (or with --yes) to install it");
    expect(err.join("\n")).toContain("SUBSHELL_SERVER_SKIP_TMUX_CHECK=1");
    // Review 2026-09-26 Important 2: EXACTLY ONE remedy line. The decline
    // notice names the route back to the offer; the rerun note (which would
    // also fire here, since `init` sets one) must not stack behind it.
    expect(err.join("\n")).not.toMatch(/Once tmux is present, rerun/);
  });

  /**
   * Operator ruling 2026-09-26, part 2: the tmux gate runs FIRST in init's
   * question sequence (verify: runInit's preflight precedes ensureConfigDir —
   * it does, and has since 2026-09-15), and a declined or failed install
   * ABORTS. These pin the abort with the strongest available evidence: the
   * config home the command would have created does not EXIST afterwards.
   */
  test("a DECLINED interactive offer aborts init: exit 1, no config home, manual + rerun in the message", async () => {
    const base = mkdtempSync(join(tmpdir(), `subshell-init-decline-${process.pid}-`));
    const fresh = join(base, "cfgh"); // init must never create it
    const { deps, err, out, prompts } = makeDeps({
      configDir: fresh,
      home: join(base, "home"),
      isTTY: true,
      platform: "darwin",
      which: (n) => (n === "brew" ? "/opt/homebrew/bin/brew" : null),
      spawnInstall: () => 0,
      answers: ["n"], // declined at the offer; the interview never starts
      confirmations: [],
    });
    expect(await runInit({}, deps)).toBe(1);
    expect(prompts[0]?.[0]).toMatch(/Install tmux now with brew\?/);
    expect(statSync(fresh, { throwIfNoEntry: false })).toBeUndefined();
    const text = err.join("\n");
    // The message states the need, names the declined manager's manual
    // command, notes the binary is installed, and gives the rerun (2026-09-26).
    expect(text).toMatch(/needs it to run panes|launches.*panes through tmux|cannot run without it/i);
    expect(text).toContain("brew install tmux");
    expect(text).toContain(join(base, "home", ".local", "bin", "subshell-server"));
    expect(text).toMatch(/rerun: subshell-server init/i);
    // Aborting means no half-questions: the service question never fired, and
    // no handoff printed for a server that will not run.
    expect(out.join("\n")).not.toMatch(/Open http/);
  });

  test("a --yes run whose installer CHILD fails aborts too: the failure is reported, not continued past", async () => {
    const base = mkdtempSync(join(tmpdir(), `subshell-init-fail-${process.pid}-`));
    const fresh = join(base, "cfgh");
    const { deps, out, err } = makeDeps({
      configDir: fresh,
      home: join(base, "home"),
      platform: "linux",
      which: (n) => (n === "apt-get" ? "/usr/bin/apt-get" : null),
      spawnInstall: () => 1, // brew/apt-style child exited non-zero
    });
    expect(await runInit({ yes: true }, deps)).toBe(1);
    expect(out.join("\n")).toMatch(/was not installed/i);
    expect(err.join("\n")).toMatch(/tmux not found/i);
    expect(statSync(fresh, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("no brew, no port, no terminal: init refuses the Homebrew bootstrap without spawning and prints the URL", async () => {
    const base = mkdtempSync(join(tmpdir(), `subshell-init-bs-${process.pid}-`));
    const fresh = join(base, "cfgh");
    let spawned = 0;
    const { deps, err } = makeDeps({
      configDir: fresh,
      home: join(base, "home"),
      isTTY: false,
      platform: "darwin",
      which: () => null,
      spawnInstall: () => {
        spawned++;
        return 0;
      },
    });
    expect(await runInit({ yes: true }, deps)).toBe(1);
    // The one thing --yes must never attempt: a password prompt no terminal
    // can answer. Nothing spawned; the instructions carry the URL instead.
    expect(spawned).toBe(0);
    expect(err.join("\n")).toContain(HOMEBREW_INSTALL_URL);
    expect(err.join("\n")).toMatch(/admin password/i);
    expect(statSync(fresh, { throwIfNoEntry: false })).toBeUndefined();
  });
});

/**
 * `init` is the whole setup sequence (spec 2026-09-15 §4.1), not just the
 * config write: a headless operator got the same verbs the desktop assistant
 * sequences, with no sequence and no handoff. These pin the two halves that
 * closes — the service question, and the sentence that says where to go next.
 */
describe("runInit — the service question", () => {
  test("interactive: asks, defaults to yes, and installs through the same seam `service install` uses", async () => {
    const h = makeDeps({ isTTY: true, answers: ["", "", "", "", ""], confirmations: [true] });
    expect(await runInit({}, h.deps)).toBe(0);
    expect(h.confirms).toEqual([["Run Subshell Server in the background and start it at login?", true]]);
    expect(h.installs).toBe(1);
    // Printed VERBATIM: on Linux the install output carries the linger hint,
    // which is the one line that decides whether a reboot keeps the server.
    expect(h.out.join("\n")).toContain("Installed (stub).");
  });

  test("interactive: answering no installs nothing, and still hands off", async () => {
    const h = makeDeps({ isTTY: true, answers: ["", "", "", "", ""], confirmations: [false] });
    expect(await runInit({}, h.deps)).toBe(0);
    expect(h.installs).toBe(0);
    expect(h.out.join("\n")).toMatch(/Open http:\/\/localhost:3080\/setup/);
  });

  // The one rule for --yes: every question takes its yes, and this one's yes
  // is install. Inverted 2026-09-26 for the OTHER silent case: a non-TTY
  // WITHOUT --yes no longer installs. `init` attaches its own terminal now
  // (piped installs run the interview on healthy machines), so the run that
  // still lands here genuinely has nobody to ask, and it makes no unasked
  // system change — it prints the default it took instead.
  test("--yes takes the default (install) without asking", async () => {
    const h = makeDeps({ confirmations: [] });
    expect(await runInit({ yes: true }, h.deps)).toBe(0);
    expect(h.confirms).toEqual([]);
    expect(h.installs).toBe(1);
    expect(h.out.join("\n")).toContain("registering background service…");
  });

  test("non-TTY without --yes installs nothing and prints the default it took", async () => {
    const h = makeDeps();
    expect(await runInit({}, h.deps)).toBe(0);
    expect(h.confirms).toEqual([]);
    expect(h.installs).toBe(0);
    expect(h.out.join("\n")).toContain(
      "not interactive: background service NOT installed (run: subshell-server service install to add it, or re-run init in a terminal)",
    );
    // The config WAS written, so the handoff still prints: this is a taken
    // default announced, not a failed command.
    expect(h.out.join("\n")).toContain("/setup");
  });

  test("--no-service is the opt-out, and it is never asked about", async () => {
    const h = makeDeps({ isTTY: true, answers: ["", "", "", "", ""] });
    expect(await runInit({ service: false }, h.deps)).toBe(0);
    expect(h.confirms).toEqual([]);
    expect(h.installs).toBe(0);
  });

  test("--service is the explicit opposite and also skips the question", async () => {
    const h = makeDeps({ isTTY: true, answers: ["", "", "", "", ""] });
    expect(await runInit({ service: true }, h.deps)).toBe(0);
    expect(h.confirms).toEqual([]);
    expect(h.installs).toBe(1);
  });

  test("a failed install fails init and does NOT hand off to a server nobody can reach", async () => {
    const h = makeDeps({
      installService: () => ({ code: 1, out: "", err: "systemctl --user daemon-reload failed\n" }),
    });
    expect(await runInit({ yes: true }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("daemon-reload failed");
    expect(h.out.join("\n")).not.toContain("/setup");
  });

  test("a cancelled question is 'not that part', not a failed init: config stands, handoff still printed", async () => {
    const h = makeDeps({ isTTY: true, answers: ["", "", "", "", ""], confirmations: [null] });
    expect(await runInit({}, h.deps)).toBe(0);
    expect(h.installs).toBe(0);
    expect(h.out.join("\n")).toContain("/setup");
  });
});

describe("runInit — the handoff", () => {
  test("names the configured base URL, read back from the file that was just written", async () => {
    const h = makeDeps();
    expect(await runInit({ yes: true, baseUrl: "http://box.local:9000", port: "9000" }, h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("Open http://box.local:9000/setup in a browser to create the admin account.");
  });

  // The LAN bind with a loopback base URL: the machine's own ADDRESSES sign
  // in without any act now (`lan-origins.ts`), but its NAME does not, and a
  // hostname is what a person at a second machine will type. So the handoff
  // says which is which, and names the flag for the one that needs it.
  test("a LAN bind with a loopback base URL names the host address and the fix", async () => {
    const h = makeDeps();
    expect(await runInit({ yes: true, host: "0.0.0.0" }, h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("http://test-host:3080");
    expect(text).toContain("--trusted-origins");
    // The address case is no longer a 403 — saying so is what keeps this
    // sentence from reading as the old warning.
    expect(text).toMatch(/LAN address/i);
    expect(text).not.toMatch(/is the configuration whose only symptom/i);
  });

  test("a loopback bind says nothing about other machines", async () => {
    const h = makeDeps();
    expect(await runInit({ yes: true, host: "127.0.0.1" }, h.deps)).toBe(0);
    expect(h.out.join("\n")).not.toContain("test-host");
  });
});
