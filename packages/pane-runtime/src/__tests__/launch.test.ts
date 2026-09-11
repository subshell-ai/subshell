import { describe, expect, it } from "bun:test";
import { getHarness } from "../index.js";
import { buildHarnessCommand, ENV_KEY_RE, validateWorkingDir } from "../launch.js";

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
    expect(cmd).toContain(`TERM="$TERM"`); // appended when the profile doesn't set TERM
  });
  it("lets an explicit profile TERM win over the literal", () => {
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

describe("validateWorkingDir", () => {
  it("resolves an existing dir to its realpath", async () => {
    expect(await validateWorkingDir("/tmp")).toBeTypeOf("string");
  });
  it("rejects missing paths and non-strings", async () => {
    await expect(validateWorkingDir("/nope/nope/nope")).rejects.toThrow(/Path does not exist/);
    await expect(validateWorkingDir("" as never)).rejects.toThrow(/workingDir is required/);
  });
});
