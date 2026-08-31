import { describe, expect, it } from "bun:test";
import { PiPlugin } from "../pi.js";
import type { ProfileDefinition } from "../types.js";

const plugin = new PiPlugin();

function profile(overrides: Partial<ProfileDefinition> = {}): ProfileDefinition {
  return { name: "p", env: {}, flags: [], settings: null, configIsolation: false, ...overrides };
}

describe("PiPlugin", () => {
  it("has stable metadata", () => {
    expect(plugin.id).toBe("pi");
    expect(plugin.name).toBe("pi");
    expect(plugin.ttyRequired).toBe(true);
    expect(plugin.enabledByDefault).toBe(true);
  });

  it("buildCommand: maps settings and forwards the session name", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/pi",
      cwd: "/tmp/ws",
      sessionName: "Refactor auth",
      profile: profile({
        settings: { model: "sonnet:high", provider: "anthropic", thinking: "high" },
        flags: ["--offline"],
      }),
      extraFlags: ["--no-session"],
    });
    expect(cmd).toEqual([
      "/usr/bin/pi",
      "--model",
      "sonnet:high",
      "--provider",
      "anthropic",
      "--thinking",
      "high",
      "--name",
      "Refactor auth",
      "--offline",
      "--no-session",
    ]);
  });

  it("buildCommand: no name flag when the session name is empty", () => {
    const cmd = plugin.buildCommand({ binary: "/usr/bin/pi", cwd: "/tmp/ws", sessionName: "", profile: profile() });
    expect(cmd).toEqual(["/usr/bin/pi"]);
  });

  it("buildCommand: keeps a multi-word flag value as one token", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/pi",
      cwd: "/tmp/ws",
      sessionName: "",
      profile: profile({ flags: ["--append-system-prompt", "be nice"] }),
    });
    expect(cmd).toEqual(["/usr/bin/pi", "--append-system-prompt", "be nice"]);
  });

  it("validateProfile: delegates to the generic checks", () => {
    expect(plugin.validateProfile(profile({ env: { X: 1 as unknown as string } })).valid).toBe(false);
    expect(plugin.validateProfile(profile()).valid).toBe(true);
  });

  it("returns null version for a missing binary override", async () => {
    const missing = new PiPlugin("/definitely/not/here");
    expect(await missing.isInstalled()).toBe(false);
    expect(await missing.getVersion()).toBeNull();
  });
});
