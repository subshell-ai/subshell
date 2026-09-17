import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "../../config-env.js";
import { runInit } from "../init.js";
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

  test("--yes never offers, even with an installer on PATH (shared gate with configure)", async () => {
    let spawned = 0;
    const { deps, prompts } = makeDeps({
      isTTY: true,
      platform: "linux",
      which: (n) => (n === "apt-get" ? "/usr/bin/apt-get" : null),
      spawnInstall: () => {
        spawned++;
        return 0;
      },
    });
    expect(await runInit({ yes: true }, deps)).toBe(1);
    expect(prompts).toEqual([]);
    expect(spawned).toBe(0);
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

  // The one rule for --yes: every question takes its default, and this one's
  // default is yes. A non-TTY without --yes behaves the same way, which is
  // what makes `curl | sh` land on a running server.
  test("--yes takes the default (install) without asking", async () => {
    const h = makeDeps({ confirmations: [] });
    expect(await runInit({ yes: true }, h.deps)).toBe(0);
    expect(h.confirms).toEqual([]);
    expect(h.installs).toBe(1);
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
