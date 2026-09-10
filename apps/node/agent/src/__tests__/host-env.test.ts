import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hostEnvReport } from "../host-env.js";

/**
 * The `ready` environment report (spec 2026-09-10 §5).
 *
 * The rule the whole module exists for: the node reports its `homeDir` plus
 * the values of variables the installed plugins' MANIFESTS declared — never
 * its whole environment. Reading declarations from package.json is also why
 * this needs no plugin code: identity and detection already live in manifest
 * data, and the ready frame must not be the one place that loads a plugin.
 */

const made: string[] = [];

function freshDataDir(): string {
  // realpath'd: the rest of the suite does, and a macOS /private symlink here
  // could never affect this module's behavior — but a surprise-free path keeps
  // failures honest.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subshell-hostenv-")));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const name of ["HOST_ENV_TEST_A", "HOST_ENV_TEST_MISSING", "HOST_ENV_TEST_UNDECLARED"]) {
    delete process.env[name];
  }
});

/** Write one installed plugin's package.json with the given `subshell` extras. */
function install(dataDir: string, id: string, subshellExtras: Record<string, unknown> = {}): void {
  const dir = join(dataDir, "plugins", id);
  mkdirSync(dir, { recursive: true });
  // Same JSON `listInstalled` reads: a real parsed manifest, no plugin code.
  Bun.write(
    join(dir, "package.json"),
    JSON.stringify({
      name: `@acme/plugin-${id}`,
      version: "1.0.0",
      subshell: {
        apiVersion: 1,
        id,
        type: "agent-harness",
        name: id,
        description: "",
        entry: "dist/index.js",
        ...subshellExtras,
      },
    }),
  );
}

describe("hostEnvReport", () => {
  it("reports homeDir, declared variables that are set, and NOTHING else", async () => {
    const dataDir = freshDataDir();
    install(dataDir, "claude-ish", { hostEnv: ["HOST_ENV_TEST_A", "HOST_ENV_TEST_MISSING"] });
    process.env.HOST_ENV_TEST_A = "a-value";
    // Set but undeclared: the whole environment is exactly what this must not
    // ship to the control plane.
    process.env.HOST_ENV_TEST_UNDECLARED = "secret";

    const report = await hostEnvReport(dataDir);
    expect(report.homeDir).toBe(homedir());
    // Declared-but-unset stays ABSENT — the plugin's own fallback reads an
    // absent key, which is the documented fallback trigger.
    expect(report.env).toEqual({ HOST_ENV_TEST_A: "a-value" });
  });

  it("a manifest naming the wrong variable reports it absent, silently (spec §11)", async () => {
    // The landmine, end to end. `CLAUDE_CONFIG_DIRR` is what a typo in the
    // declaration produces. Nothing throws and nothing warns: the reported
    // env lacks the real variable (it was never declared), and the typo names
    // one nothing sets, so a control-plane `resumePath` falls back to the
    // home default and the resume quietly never offers itself on a machine
    // whose config dir IS overridden. Kept permanently because that failure
    // has no other signature.
    const dataDir = freshDataDir();
    install(dataDir, "claude-code", { hostEnv: ["CLAUDE_CONFIG_DIRR"] });
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/real/override";
    try {
      const report = await hostEnvReport(dataDir);
      expect(report.env).toEqual({});
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  it("an empty declared value is reported as empty, not dropped", async () => {
    // Present-but-empty is a real environment state; whether it counts as
    // "set" is the PLUGIN's decision (claude trims it into its fallback), not
    // this module's. Report what the machine says.
    const dataDir = freshDataDir();
    install(dataDir, "p", { hostEnv: ["HOST_ENV_TEST_A"] });
    process.env.HOST_ENV_TEST_A = "";
    const report = await hostEnvReport(dataDir);
    expect(report.env).toEqual({ HOST_ENV_TEST_A: "" });
  });

  it("no plugins directory is not a failure: homeDir and an empty env", async () => {
    const report = await hostEnvReport(freshDataDir());
    expect(report).toEqual({ homeDir: homedir(), env: {} });
  });

  it("a broken plugin's declarations are not consulted", async () => {
    // It cannot run, so its variables are nobody's business; and its manifest
    // may be malformed JSON, which must not sink the ready frame.
    const dataDir = freshDataDir();
    const dir = join(dataDir, "plugins", "broken-one");
    mkdirSync(dir, { recursive: true });
    Bun.write(join(dir, "package.json"), "{ not json");
    const report = await hostEnvReport(dataDir);
    expect(report.env).toEqual({});
    expect(report.homeDir).toBe(homedir());
  });

  it("unions the declarations of every installed plugin", async () => {
    const dataDir = freshDataDir();
    install(dataDir, "one", { hostEnv: ["HOST_ENV_TEST_A"] });
    install(dataDir, "two", { hostEnv: ["HOST_ENV_TEST_A", "HOST_ENV_TEST_MISSING"] });
    process.env.HOST_ENV_TEST_A = "shared";
    const report = await hostEnvReport(dataDir);
    expect(report.env).toEqual({ HOST_ENV_TEST_A: "shared" });
  });
});
