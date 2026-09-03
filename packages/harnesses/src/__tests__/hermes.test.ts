import { describe, expect, it } from "bun:test";
import { HermesPlugin } from "../hermes.js";
import type { ProfileDefinition } from "../types.js";

const plugin = new HermesPlugin();

function profile(overrides: Partial<ProfileDefinition> = {}): ProfileDefinition {
  return { name: "p", env: {}, flags: [], settings: null, configIsolation: false, ...overrides };
}

describe("HermesPlugin", () => {
  it("has stable metadata", () => {
    expect(plugin.id).toBe("hermes");
    expect(plugin.name).toBe("Hermes Agent");
    expect(plugin.ttyRequired).toBe(true);
    expect(plugin.enabledByDefault).toBe(true);
  });

  it("buildCommand: maps settings to flags, then profile and extra flags", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/hermes",
      cwd: "/tmp/ws",
      subshellName: "ignored",
      profile: profile({
        settings: { model: "anthropic/claude-sonnet-4.6", provider: "openrouter", toolsets: "web,files" },
        flags: ["--yolo"],
      }),
      extraFlags: ["--worktree"],
    });
    expect(cmd).toEqual([
      "/usr/bin/hermes",
      "-m",
      "anthropic/claude-sonnet-4.6",
      "--provider",
      "openrouter",
      "-t",
      "web,files",
      "--yolo",
      "--worktree",
    ]);
  });

  it("buildCommand: keeps a multi-word flag value as one token", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/hermes",
      cwd: "/tmp/ws",
      subshellName: "",
      profile: profile({ flags: ["--skills", "my skill"] }),
    });
    expect(cmd).toEqual(["/usr/bin/hermes", "--skills", "my skill"]);
  });

  it("validateProfile: delegates to the generic checks", () => {
    expect(plugin.validateProfile(profile({ name: "" })).valid).toBe(false);
    expect(plugin.validateProfile(profile()).valid).toBe(true);
  });

  it("getVersion: extracts the semver from the real multi-line block", async () => {
    const fake = "#!/bin/sh\nprintf 'Hermes Agent v0.16.0 (2026.6.5) - upstream 5e01a5db\\nProject: /x\\n'\n";
    const path = `/tmp/hermes-fake-${process.pid}.sh`;
    await Bun.write(path, fake);
    await Bun.$`chmod +x ${path}`.quiet();
    const p = new HermesPlugin(path);
    expect(await p.getVersion()).toBe("0.16.0");
  });

  it("getVersion: falls back to the whole first line when there is no semver", async () => {
    const fake = `#!/bin/sh\nprintf 'custom-hermes-build\\nother\\n'\n`;
    const path = `/tmp/hermes-fake-nover-${process.pid}.sh`;
    await Bun.write(path, fake);
    await Bun.$`chmod +x ${path}`.quiet();
    const p = new HermesPlugin(path);
    expect(await p.getVersion()).toBe("custom-hermes-build");
  });

  it("returns null version for a missing binary override", async () => {
    const missing = new HermesPlugin("/definitely/not/here");
    expect(await missing.isInstalled()).toBe(false);
    expect(await missing.getVersion()).toBeNull();
  });
});
