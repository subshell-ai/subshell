import { afterEach, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { hostEnvAnswers, reportHomeDir } from "../host-env.js";

/**
 * The `detect` environment answers (spec 2026-09-10 §5, as amended by the
 * final review).
 *
 * The rule the whole module exists for: the PLANE names the variables (the
 * union of `subshell.hostEnv` across its enabled manifests — a node has held
 * no manifests since the inversion), and the node answers the values it has
 * for exactly those names. It never scans its environment, and nothing here
 * reads a plugins directory.
 */

const NAMES = ["HOST_ENV_TEST_A", "HOST_ENV_TEST_MISSING", "HOST_ENV_TEST_UNDECLARED"];

afterEach(() => {
  for (const name of NAMES) delete process.env[name];
});

describe("hostEnvAnswers", () => {
  it("answers asked names that are set, and NOTHING else", () => {
    process.env.HOST_ENV_TEST_A = "a-value";
    // Set but not asked about: the whole environment is exactly what this
    // must not ship to the control plane.
    process.env.HOST_ENV_TEST_UNDECLARED = "secret";

    const env = hostEnvAnswers(["HOST_ENV_TEST_A", "HOST_ENV_TEST_MISSING"]);
    // Asked-but-unset stays ABSENT — the plugin's own fallback reads an
    // absent key, which is the documented fallback trigger.
    expect(env).toEqual({ HOST_ENV_TEST_A: "a-value" });
  });

  it("a name the plane mis-declares answers absent, silently (spec §11)", () => {
    // The landmine, end to end. `CLAUDE_CONFIG_DIRR` is what a typo in a
    // manifest declaration produces. Nothing throws and nothing warns: the
    // answer lacks the real variable (it was never asked for), so a
    // control-plane `resumePath` falls back to the home default and the
    // resume quietly never offers itself on a machine whose config dir IS
    // overridden. Kept permanently because that failure has no other
    // signature.
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/real/override";
    try {
      expect(hostEnvAnswers(["CLAUDE_CONFIG_DIRR"])).toEqual({});
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  it("an empty set value is reported as empty, not dropped", () => {
    // Present-but-empty is a real environment state; whether it counts as
    // "set" is the PLUGIN's decision (claude trims it into its fallback), not
    // this module's. Report what the machine says.
    process.env.HOST_ENV_TEST_A = "";
    expect(hostEnvAnswers(["HOST_ENV_TEST_A"])).toEqual({ HOST_ENV_TEST_A: "" });
  });

  it("an empty name list answers {} — the ordinary no-manifests case", () => {
    process.env.HOST_ENV_TEST_A = "a-value";
    expect(hostEnvAnswers([])).toEqual({});
  });
});

describe("reportHomeDir", () => {
  it("reports this user's home", () => {
    expect(reportHomeDir()).toBe(homedir());
  });
});
