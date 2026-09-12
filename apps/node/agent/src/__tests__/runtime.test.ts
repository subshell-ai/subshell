import { describe, expect, it } from "bun:test";
import { collectRuntime } from "../runtime.js";

const running = {
  installed: true,
  definitionPath: "/u/.config/systemd/user/subshell.service",
  state: "running",
  pid: 99,
  enabled: true,
  paneSafety: "keeps",
  detail: "",
  logPath: null,
} as const;

describe("collectRuntime", () => {
  it("is supervised only when the manager's pid is ours, names the journal on linux, and dates startedAt from uptime", async () => {
    const r = await collectRuntime({
      platform: "linux",
      pid: 99,
      queryService: async () => running as never,
      which: (n) => (n === "tmux" ? "/usr/bin/tmux" : null),
      configPath: "/u/.config/subshell/config.json",
      binaryPath: "/u/.local/bin/subshell",
      now: () => Date.UTC(2026, 8, 12, 10, 0, 30),
      uptimeSeconds: () => 30,
    });
    expect(r.supervised).toBe(true);
    expect(r.service.manager).toBe("systemd");
    expect(r.logHint).toContain("journalctl --user -u subshell.service");
    expect(r.startedAt).toBe("2026-09-12T10:00:00.000Z");
    expect(r.tmuxPath).toBe("/usr/bin/tmux");
    expect(r.binaryPath).toBe("/u/.local/bin/subshell");
  });

  it("is not supervised under a different pid, and reports the log file on darwin", async () => {
    const r = await collectRuntime({
      platform: "darwin",
      pid: 1,
      queryService: async () => ({ ...running, logPath: "/u/Library/Logs/subshell.log" }) as never,
      which: () => null,
      configPath: "/c",
      binaryPath: "/b",
    });
    expect(r.supervised).toBe(false);
    expect(r.service.manager).toBe("launchd");
    expect(r.logPath).toBe("/u/Library/Logs/subshell.log");
    expect(r.logHint).toBeNull();
  });

  it("degrades an absent paneSafety to unknown and names no manager off the two platforms", async () => {
    const r = await collectRuntime({
      platform: "win32",
      pid: 5,
      queryService: async () =>
        ({ installed: false, definitionPath: null, state: "not-installed", pid: null, enabled: null }) as never,
      which: () => null,
      configPath: "/c",
      binaryPath: "/b",
    });
    expect(r.service.manager).toBeNull();
    expect(r.service.paneSafety).toBe("unknown");
    expect(r.supervised).toBe(false);
    expect(r.logHint).toBeNull();
  });
});
