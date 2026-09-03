import { describe, expect, it } from "bun:test";
import { OpencodePlugin } from "../opencode.js";
import type { ProfileDefinition } from "../types.js";

const plugin = new OpencodePlugin();

function profile(overrides: Partial<ProfileDefinition> = {}): ProfileDefinition {
  return { name: "p", env: {}, flags: [], settings: null, configIsolation: false, ...overrides };
}

describe("OpencodePlugin", () => {
  it("has stable metadata", () => {
    expect(plugin.id).toBe("opencode");
    expect(plugin.name).toBe("OpenCode");
    expect(plugin.ttyRequired).toBe(true);
    expect(plugin.enabledByDefault).toBe(true);
  });

  it("buildCommand: bare launch with no profile extra", () => {
    expect(
      plugin.buildCommand({ binary: "/usr/bin/opencode", cwd: "/tmp/ws", subshellName: "", profile: profile() }),
    ).toEqual(["/usr/bin/opencode"]);
  });

  it("buildCommand: maps settings to flags, then profile and extra flags", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/opencode",
      cwd: "/tmp/ws",
      subshellName: "ignored",
      profile: profile({
        settings: { model: "anthropic/claude-sonnet-4-5", agent: "plan", auto: true },
        flags: ["--pure"],
      }),
      extraFlags: ["--mini"],
    });
    expect(cmd).toEqual([
      "/usr/bin/opencode",
      "-m",
      "anthropic/claude-sonnet-4-5",
      "--agent",
      "plan",
      "--auto",
      "--pure",
      "--mini",
    ]);
  });

  it("buildCommand: keeps a multi-word flag value as one token", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/opencode",
      cwd: "/tmp/ws",
      subshellName: "",
      profile: profile({ flags: ["--prompt", "be nice"] }),
    });
    expect(cmd).toEqual(["/usr/bin/opencode", "--prompt", "be nice"]);
  });

  it("buildCommand: ignores non-string settings values", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/opencode",
      cwd: "/tmp/ws",
      subshellName: "",
      profile: profile({ settings: { model: 42, agent: "", auto: "yes" } }),
    });
    expect(cmd).toEqual(["/usr/bin/opencode"]);
  });

  it("validateProfile: delegates to the generic checks", () => {
    expect(plugin.validateProfile(profile({ name: " " })).valid).toBe(false);
    expect(plugin.validateProfile(profile({ flags: ["pure"] })).valid).toBe(false);
    expect(plugin.validateProfile(profile()).valid).toBe(true);
  });

  it("finds a binary via explicit override", async () => {
    const withOverride = new OpencodePlugin(process.execPath);
    expect(await withOverride.isInstalled()).toBe(true);
    expect(await withOverride.getVersion()).not.toBeNull();
  });

  it("returns null version for a missing binary override", async () => {
    const missing = new OpencodePlugin("/definitely/not/here");
    expect(await missing.isInstalled()).toBe(false);
    expect(await missing.getVersion()).toBeNull();
  });
});
