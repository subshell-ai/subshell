import { describe, expect, it } from "bun:test";
import { getHarness } from "../index.js";
import {
  assembleHarnessCommand,
  buildHarnessCommand,
  curatedEnv,
  ENV_KEY_RE,
  paneEnvFor,
  validateWorkingDir,
} from "../launch.js";
import { shellQuote } from "../shell.js";

describe("buildHarnessCommand", () => {
  const pi = getHarness("pi");
  it("assembles env -i with quoted values and the TERM literal", () => {
    if (!pi) throw new Error("pi plugin missing");
    const cmd = buildHarnessCommand(
      pi,
      "/usr/bin/pi",
      "/home/u/proj",
      { name: "P", env: { FOO: "ba r'z" }, flags: [], settings: null, configIsolation: false },
      "sess1",
      { SUBSHELL_API_KEY: "subshell_x" },
    );
    expect(cmd.startsWith("env -i ")).toBe(true);
    expect(cmd).toContain(`FOO=${"'ba r'\\''z'"}`); // POSIX quoting of an inner quote
    expect(cmd).toContain(`SUBSHELL_API_KEY='subshell_x'`);
    expect(cmd).toContain(`TERM="$TERM"`); // appended when the preset doesn't set TERM
  });
  it("lets an explicit preset TERM win over the literal", () => {
    if (!pi) throw new Error("pi plugin missing");
    const cmd = buildHarnessCommand(
      pi,
      "/usr/bin/pi",
      "/tmp",
      { name: "P", env: { TERM: "xterm-256color" }, flags: [], settings: null, configIsolation: false },
      "s",
    );
    expect(cmd).toContain(`TERM='xterm-256color'`);
    expect(cmd).not.toContain(`TERM="$TERM"`);
  });
  it("rejects env keys that are not shell-safe names", () => {
    if (!pi) throw new Error("pi plugin missing");
    expect(() =>
      buildHarnessCommand(
        pi,
        "/bin/pi",
        "/tmp",
        { name: "P", env: { "X; touch /tmp/pwned": "1" }, flags: [], settings: null, configIsolation: false },
        "s",
      ),
    ).toThrow(/Invalid harness env var name/);
  });
  it("forwards the reporter to the plugin, so hooks name a binary the PANE has", () => {
    // The pane's machine is only guaranteed to have the subshell binary — see
    // `ReporterSpec`. A launch that dropped this on the floor is how the hooks
    // came to say `bun`, which most machines do not have.
    const claude = getHarness("claude-code");
    if (!claude) throw new Error("claude-code plugin missing");
    const cmd = buildHarnessCommand(
      claude,
      "/usr/bin/claude",
      "/home/u/proj",
      { name: "P", env: {}, flags: [], settings: null, configIsolation: false },
      "sess1",
      {},
      undefined,
      undefined,
      { command: "/usr/local/bin/subshell-server", args: ["report"] },
    );
    expect(cmd).toContain("/usr/local/bin/subshell-server");
    expect(cmd).toContain("attention");
    expect(cmd).not.toContain("bun -e");
  });

  it("keeps ENV_KEY_RE canonical", () => {
    expect(ENV_KEY_RE.test("SUBSHELL_API_KEY")).toBe(true);
    expect(ENV_KEY_RE.test("1BAD")).toBe(false);
  });
});

describe("paneEnvFor extraEnv layer (pane-preview Task 7)", () => {
  // The virtual display is the pane env's fifth layer: DISPLAY/XAUTHORITY are
  // allocated FOR this pane by the node, so they must beat a preset that names
  // the same keys (the same rule that puts the MCP wiring env above the
  // preset), and the exit hook must be built from the same map or the death
  // report leaves the pane's machine settings behind. With no fifth layer the
  // chain must be byte-identical to the four-layer spread it used to be —
  // every pane without a display rides that exact string.

  const preset = {
    name: "P",
    env: { DISPLAY: "from-preset", FOO: "bar" },
    flags: [],
    settings: null,
    configIsolation: false,
  };
  const subshellEnv = { SUBSHELL_API_KEY: "subshell_x" };
  const mcpEnv = { OPENCODE_CONFIG: "/tmp/mcp.json" };
  const displayEnv = { DISPLAY: ":91", XAUTHORITY: "/var/lib/subshell/displays/p/Xauthority" };
  const argv = ["/bin/sh", "-c", "echo hi"];

  it("the display layer beats the preset layer, and the hook env sees the same map", () => {
    const env = paneEnvFor(subshellEnv, preset, mcpEnv, displayEnv);
    // A preset DISPLAY describes someone else's screen; the allocation wins.
    expect(env.DISPLAY).toBe(":91");
    expect(env.XAUTHORITY).toBe("/var/lib/subshell/displays/p/Xauthority");
    // The other layers still ride: this is an addition to the chain, not a
    // replacement of it.
    expect(env.FOO).toBe("bar");
    expect(env.SUBSHELL_API_KEY).toBe("subshell_x");
    expect(env.OPENCODE_CONFIG).toBe("/tmp/mcp.json");
  });

  it("assembleHarnessCommand carries the layer, and the assembled env is exactly paneEnvFor's map", () => {
    // :224's exit-hook call is `exitHookFor(reporter, paneEnvFor(..., displayEnv))`
    // and the pane command is `assembleHarnessCommand(..., displayEnv)`. The
    // agreement this pins is that property: one map, two consumers, so the
    // hook can never aim at a different DISPLAY than the pane it reports for.
    const cmd = assembleHarnessCommand(argv, preset, subshellEnv, mcpEnv, displayEnv);
    const env = paneEnvFor(subshellEnv, preset, mcpEnv, displayEnv);
    for (const [k, v] of Object.entries(env)) {
      expect(cmd).toContain(`${k}=${shellQuote(String(v))}`);
    }
    expect(cmd).toContain(`DISPLAY='${displayEnv.DISPLAY}'`);
    expect(cmd).not.toContain("from-preset");
  });

  it("with no extraEnv the chain is byte-identical to the four-layer spread", () => {
    // The preservation claim, pinned: today's every-pane string comes from
    // exactly this spread, so a pane with no display must assemble it the same
    // bytes the old chain produced.
    const env = { ...curatedEnv(), ...subshellEnv, ...preset.env, ...mcpEnv };
    const envArgs = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(String(v))}`);
    if (!("TERM" in env)) envArgs.push('TERM="$TERM"');
    const expected = `env -i ${envArgs.join(" ")} ${argv.map(shellQuote).join(" ")}`;
    expect(assembleHarnessCommand(argv, preset, subshellEnv, mcpEnv)).toBe(expected);
    expect(paneEnvFor(subshellEnv, preset, mcpEnv)).toEqual(env);
  });
});

describe("validateWorkingDir", () => {
  it("resolves an existing dir to its realpath", async () => {
    expect(await validateWorkingDir("/tmp")).toBeTypeOf("string");
  });
  it("rejects missing paths and non-strings", async () => {
    await expect(validateWorkingDir("/nope/nope/nope")).rejects.toThrow(/Path does not exist/);
    await expect(validateWorkingDir("" as never)).rejects.toThrow(/workingDir is required/);
  });
});
