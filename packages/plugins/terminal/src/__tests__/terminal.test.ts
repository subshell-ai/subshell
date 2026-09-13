import { describe, expect, it } from "bun:test";
import type { BuildCommandInput, PresetDefinition } from "@subshell-ai/plugin-api";
import createPlugin, { manifest } from "../index.js";

const BLANK: PresetDefinition = {
  name: "Default",
  description: null,
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
};

function input(over: Partial<BuildCommandInput> = {}): BuildCommandInput {
  return { binary: "/bin/zsh", cwd: "/tmp/work", preset: BLANK, subshellName: "", ...over };
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

  it("appends preset flags, then extra flags, in that order", () => {
    const cmd = plugin().buildCommand(input({ preset: { ...BLANK, flags: ["-l"] }, extraFlags: ["-c", "echo hi"] }));
    expect(cmd).toEqual(["/bin/zsh", "-l", "-c", "echo hi"]);
  });

  it("ignores the subshell name, having no flag for it", () => {
    expect(plugin().buildCommand(input({ subshellName: "review" }))).toEqual(["/bin/zsh"]);
  });

  it("accepts a blank preset", () => {
    expect(plugin().validatePreset(BLANK).valid).toBe(true);
  });
});

describe("terminal version parsing", () => {
  it("takes the number out of bash's multi-line banner, not the licence", () => {
    // What a real host answers, and what the harness list rendered whole
    // before this existed (found running the first-run wizard end to end).
    const bash = [
      "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)",
      "Copyright (C) 2022 Free Software Foundation, Inc.",
      "License GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>",
      "",
      "This is free software; you are free to change and redistribute it.",
      "There is NO WARRANTY, to the extent permitted by law.",
    ].join("\n");

    expect(plugin().parseVersion?.(bash)).toBe("5.2.21");
  });

  it("leaves a one-line shell alone", () => {
    expect(plugin().parseVersion?.("zsh 5.9 (x86_64-ubuntu-linux-gnu)")).toBe("5.9");
  });

  it("falls back to the first line rather than to nothing", () => {
    // A shell that names itself oddly is still usable; its row should say
    // something instead of going blank.
    expect(plugin().parseVersion?.("some-shell (unversioned)")).toBe("some-shell (unversioned)");
  });

  it("answers null only when there is nothing to read", () => {
    expect(plugin().parseVersion?.("   \n\n  ")).toBeNull();
  });
});
