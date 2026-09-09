import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());

describe("ClaudeCodePlugin.exitStatus", () => {
  const p = createPlugin(createTestHost());
  it("maps known codes", () => {
    expect(p.exitStatus?.(10)).toContain("loop");
    expect(p.exitStatus?.(1)).toContain("error");
    expect(p.exitStatus?.(5)).toContain("permission");
  });
  it("returns null for unknown", () => {
    expect(p.exitStatus?.(999)).toBeNull();
  });
});

describe("ClaudeCodePlugin", () => {
  it("declares its identity in the manifest, not in the plugin", () => {
    // Identity moved to package.json so a host can list and detect this
    // plugin without importing or running a line of it.
    expect(manifest.id).toBe("claude-code");
    expect(manifest.name).toBe("Claude Code");
    expect(manifest.type).toBe("agent-harness");
    expect(manifest.detect?.binaryName).toBe("claude");
    expect(manifest.detect?.envOverride).toBe("CLAUDE_PATH");
  });

  it("declares the capabilities it implements", () => {
    expect(plugin.capabilities().sort()).toEqual(["attention", "mcp", "resume", "settings"]);
  });

  it("buildCommand: bare launch with no profile extra", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      subshellName: "",
      profile: emptyProfile(),
    });
    expect(cmd).toEqual(["/usr/bin/claude", "--settings", expect.any(String)]);
    expect(JSON.parse(cmd[2]).hooks).toBeDefined();
  });

  it("buildCommand: passes settings JSON, name, flags", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      subshellName: "My Subshell",
      profile: {
        name: "p",
        env: {},
        flags: ["--permission-mode", "plan", "--model", "sonnet"],
        settings: { permissionMode: "plan", model: "sonnet" },
        configIsolation: false,
      },
    });
    expect(cmd[0]).toBe("/usr/bin/claude");
    expect(cmd).toContain("--settings");
    const settingsIdx = cmd.indexOf("--settings");
    // The merged JSON must carry the profile's keys verbatim; `hooks` is
    // subshell's addition and rides alongside (see the attention-hooks describe).
    expect(JSON.parse(cmd[settingsIdx + 1])).toMatchObject({ permissionMode: "plan", model: "sonnet" });
    expect(JSON.parse(cmd[settingsIdx + 1]).hooks).toBeDefined();
    expect(cmd).toContain("--name");
    expect(cmd[cmd.indexOf("--name") + 1]).toBe("My Subshell");
    expect(cmd).toContain("--permission-mode");
    expect(cmd).toContain("plan");
  });

  it("buildCommand: passes each flag entry through as one argv token", () => {
    // The row editor stores already-tokenized flags; a value with spaces is
    // one deliberate argument, so buildCommand must never re-split it.
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      subshellName: "",
      profile: {
        name: "p",
        env: {},
        flags: ["--append-system-prompt", "be nice"],
        settings: null,
        configIsolation: false,
      },
    });
    expect(cmd).toEqual(["/usr/bin/claude", "--settings", expect.any(String), "--append-system-prompt", "be nice"]);
  });

  it("validateProfile: rejects missing name and bad flags", () => {
    expect(plugin.validateProfile({ name: "", env: {}, flags: [], settings: null, configIsolation: false }).valid).toBe(
      false,
    );
    const bad = plugin.validateProfile({
      name: "x",
      env: { FOO: "bar", NOPE: "ok" },
      flags: ["nopeflag"],
      settings: null,
      configIsolation: false,
    });
    expect(bad.valid).toBe(false);
    expect(bad.issues.some((i) => i.field === "flags")).toBe(true);
  });

  it("leaves binary resolution to the host", () => {
    // The plugin declares no `detect`: the host resolves `claude` from the
    // manifest's detect block. These used to be two cases about an injected
    // binary override, a seam the manifest removed.
    expect(plugin.detect).toBeUndefined();
  });
});

function emptyProfile(): ProfileDefinition {
  return { name: "default", env: {}, flags: [], settings: null, configIsolation: false };
}

describe("ClaudeCodePlugin MCP config injection", () => {
  it("splices the registration's argv right after the binary", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      profile: { name: "P", env: {}, flags: [], settings: null, configIsolation: false },
      subshellName: "",
      mcp: {
        fileContent: "{}",
        args: ["--mcp-config", "/data/mcp/sess-1.json"],
      },
    });
    expect(cmd.slice(0, 3)).toEqual(["/usr/bin/claude", "--mcp-config", "/data/mcp/sess-1.json"]);
  });

  it("omits --mcp-config when no registration is provided", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      profile: { name: "P", env: {}, flags: [], settings: null, configIsolation: false },
      subshellName: "",
    });
    expect(cmd).not.toContain("--mcp-config");
  });
});

describe("ClaudeCodePlugin restart-resume", () => {
  it("start mode pins the conversation id with --session-id", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      profile: emptyProfile(),
      subshellName: "",
      harnessSession: { id: "11111111-1111-4111-8111-111111111111", mode: "start" },
    });
    expect(cmd).toEqual([
      "/usr/bin/claude",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
      "--settings",
      expect.any(String),
    ]);
  });

  it("resume mode continues the conversation with --resume", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      profile: emptyProfile(),
      subshellName: "x",
      harnessSession: { id: "11111111-1111-4111-8111-111111111111", mode: "resume" },
    });
    expect(cmd).toEqual([
      "/usr/bin/claude",
      "--resume",
      "11111111-1111-4111-8111-111111111111",
      "--settings",
      expect.any(String),
      "--name",
      "x",
    ]);
  });

  it("no harnessSession means no conversation flags at all", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      profile: emptyProfile(),
      subshellName: "",
    });
    expect(cmd).not.toContain("--resume");
    expect(cmd).not.toContain("--session-id");
  });

  describe("resume.canResume", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    // Point claude's state dir at a temp tree so the probe is testable
    // without touching the developer's real ~/.claude.
    function withConfigDir(body: (dir: string) => void) {
      const dir = mkdtempSync(join(tmpdir(), "subshell-claude-cfg-"));
      process.env.CLAUDE_CONFIG_DIR = dir;
      try {
        body(dir);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
        if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved;
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("is true only when the pinned transcript exists under the cwd's slug dir", () => {
      withConfigDir((dir) => {
        const id = plugin.resume?.allocateHarnessSessionId() ?? "";
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        const slug = join(dir, "projects", "-tmp-my-project");
        mkdirSync(slug, { recursive: true });
        expect(plugin.resume?.canResume(id, "/tmp/my.project")).toBe(false);
        writeFileSync(join(slug, `${id}.jsonl`), "{}");
        expect(plugin.resume?.canResume(id, "/tmp/my.project")).toBe(true);
        // The same id in another project dir is not resumable there.
        expect(plugin.resume?.canResume(id, "/tmp/other")).toBe(false);
      });
    });
  });
});

describe("ClaudeCodePlugin attention hooks", () => {
  it("declares native attention-hook support", () => {
    expect(plugin.supportsAttentionHooks).toBe(true);
  });

  it("always emits --settings carrying Stop and Notification hooks", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      profile: emptyProfile(),
      subshellName: "",
    });
    const idx = cmd.indexOf("--settings");
    expect(idx).toBeGreaterThan(-1);
    const settings = JSON.parse(cmd[idx + 1]) as {
      hooks: { Stop?: unknown[]; Notification?: unknown[] };
    };
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.Notification).toBeDefined();
    const stopCmd = (settings.hooks.Stop as [{ hooks: [{ command: string }] }])[0].hooks[0].command;
    expect(stopCmd).toContain("bun -e");
    expect(stopCmd).toContain("/attention");
    expect(stopCmd).toContain("turn_complete");
    const notifCmd = (settings.hooks.Notification as [{ hooks: [{ command: string }] }])[0].hooks[0].command;
    expect(notifCmd).toContain("needs_attention");
  });

  it("profile settings survive the merge (hooks added alongside, not replacing)", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      profile: { name: "p", env: {}, flags: [], settings: { model: "sonnet" }, configIsolation: false },
      subshellName: "",
    });
    const settings = JSON.parse(cmd[cmd.indexOf("--settings") + 1]) as Record<string, unknown>;
    expect(settings.model).toBe("sonnet");
    expect(settings.hooks).toBeDefined();
  });

  it("SessionStart reports the pane's current session id to /harness-session", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      profile: emptyProfile(),
      subshellName: "",
    });
    const idx = cmd.indexOf("--settings");
    const settings = JSON.parse(cmd[idx + 1]) as {
      hooks: { SessionStart?: [{ hooks: [{ command: string }] }] };
    };
    const ss = settings.hooks.SessionStart;
    expect(ss).toBeDefined();
    const ssCmd = ss?.[0].hooks[0].command ?? "";
    expect(ssCmd).toContain("bun -e");
    expect(ssCmd).toContain("/harness-session");
    // The hook forwards ONLY the payload's session_id — the id is what
    // restart-resume needs, nothing else from stdin may leave the pane.
    expect(ssCmd).toContain("session_id");
    expect(ssCmd).not.toContain("transcript_path");
    expect(ssCmd).not.toContain("last_assistant_message");
    // Both awaits are bounded: a self-kill timer caps the whole hook (a
    // SessionStart hook blocks the pane start until it exits), and a short
    // fetch timeout caps the POST.
    expect(ssCmd).toContain("setTimeout(()=>process.exit(0),4000)");
    expect(ssCmd).toContain("AbortSignal.timeout(2000)");
  });
});
