import { describe, expect, it } from "bun:test";
import type { BuildCommandInput, ProfileDefinition } from "@subshell-ai/plugin-api";
import createPlugin, { manifest } from "../index.js";

const BLANK: ProfileDefinition = {
  name: "Default",
  description: null,
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
};

function input(over: Partial<BuildCommandInput> = {}): BuildCommandInput {
  return { binary: "/bin/zsh", cwd: "/tmp/work", profile: BLANK, subshellName: "", ...over };
}

const plugin = () => createPlugin({} as never);

describe("terminal manifest", () => {
  it("is a terminal-type plugin", () => {
    expect(manifest.id).toBe("terminal");
    expect(manifest.type).toBe("terminal");
  });

  it("detects the user's login shell through SHELL", () => {
    // Rung 1 of detectBinaryWithOptions reads this variable and returns it
    // when it is executable, which is what makes this plugin resolve with
    // nothing installed. See the spec, section 3.1.
    expect(manifest.detect?.envOverride).toBe("SHELL");
    expect(manifest.detect?.binaryName).toBe("bash");
  });

  it("declares no knownPaths, because they are joined against HOME", () => {
    // binary-lookup.ts joins every knownPath against $HOME, so an absolute
    // "/bin/sh" would resolve to "$HOME/bin/sh" and silently never match.
    // Absolute fallbacks do not belong here; rungs 2 and 5 cover the case.
    expect(manifest.detect?.knownPaths).toEqual([]);
  });
});

describe("terminal plugin", () => {
  it("declares no capabilities", () => {
    // A bare shell has no MCP dialect, no resumable conversation, no
    // attention signal and no settings. Capabilities are validated at load,
    // so claiming one it does not implement would be a launch-time failure.
    expect(plugin().capabilities()).toEqual([]);
  });

  it("runs the resolved shell bare", () => {
    expect(plugin().buildCommand(input())).toEqual(["/bin/zsh"]);
  });

  it("appends profile flags, then extra flags, in that order", () => {
    const cmd = plugin().buildCommand(input({ profile: { ...BLANK, flags: ["-l"] }, extraFlags: ["-c", "echo hi"] }));
    expect(cmd).toEqual(["/bin/zsh", "-l", "-c", "echo hi"]);
  });

  it("ignores the subshell name, having no flag for it", () => {
    expect(plugin().buildCommand(input({ subshellName: "review" }))).toEqual(["/bin/zsh"]);
  });

  it("accepts a blank profile", () => {
    expect(plugin().validateProfile(BLANK).valid).toBe(true);
  });
});
