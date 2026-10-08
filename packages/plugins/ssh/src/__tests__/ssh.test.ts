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
  return { binary: "/usr/bin/ssh", cwd: "/tmp/work", preset: BLANK, subshellName: "", ...over };
}

const plugin = () => createPlugin({} as never);

describe("ssh manifest", () => {
  it("is a terminal-type plugin", () => {
    expect(manifest.id).toBe("ssh");
    expect(manifest.type).toBe("terminal");
  });

  it("declares the ssh binary and the operator's pin seam", () => {
    // `SUBSHELL_SSH_PATH` is the same override the agent's tier-1 ssh-shared
    // ladder reads, so one operator setting names one binary everywhere.
    expect(manifest.detect?.binaryName).toBe("ssh");
    expect(manifest.detect?.envOverride).toBe("SUBSHELL_SSH_PATH");
  });

  it("names the stock install locations as ABSOLUTE paths", () => {
    // Rung 3 of binary-lookup.ts uses a leading-`/` entry verbatim (it is a
    // LOCATION, not a HOME-relative hint), so these are the actual system
    // locations: Linux, the macOS base install, and Homebrew.
    expect(manifest.detect?.knownPaths).toEqual([
      "/usr/bin/ssh",
      "/bin/ssh",
      "/usr/local/bin/ssh",
      "/opt/homebrew/bin/ssh",
    ]);
  });
});

describe("ssh plugin", () => {
  it("declares no capabilities", () => {
    // The remote shell hosts no local process that could speak MCP, resume a
    // conversation, or edit settings. Capabilities are validated at load, so
    // claiming one it does not implement would be a launch-time failure.
    expect(plugin().capabilities()).toEqual([]);
  });

  it("runs the resolved binary with the preset flags", () => {
    const cmd = plugin().buildCommand(
      input({ preset: { ...BLANK, flags: ["-F", "/var/lib/subshell/ssh/sess/config", "example.com"] } }),
    );
    expect(cmd).toEqual(["/usr/bin/ssh", "-F", "/var/lib/subshell/ssh/sess/config", "example.com"]);
  });

  it("appends preset flags, then extra flags, in that order", () => {
    const cmd = plugin().buildCommand(
      input({ preset: { ...BLANK, flags: ["-J", "bastion"] }, extraFlags: ["-A", "host.example"] }),
    );
    expect(cmd).toEqual(["/usr/bin/ssh", "-J", "bastion", "-A", "host.example"]);
  });

  it("runs bare when nothing is configured", () => {
    expect(plugin().buildCommand(input())).toEqual(["/usr/bin/ssh"]);
  });

  it("ignores the subshell name, having no flag for it", () => {
    expect(plugin().buildCommand(input({ subshellName: "prod box" }))).toEqual(["/usr/bin/ssh"]);
  });

  it("accepts a blank preset", () => {
    expect(plugin().validatePreset(BLANK).valid).toBe(true);
  });
});
