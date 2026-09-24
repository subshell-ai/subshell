import { describe, expect, it } from "bun:test";
import type { PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());

/**
 * The reporter a control plane resolves for the pane's own machine — present
 * on every real launch, so the argv-shape cases below carry it too.
 */
const reporter = { command: "/usr/local/bin/subshell-server", args: ["report"] };

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
    // The env `resumePath` computes against. A typo here is the silent
    // failure documented in the resumePath describe: the node reports a name
    // nothing sets, and the resume quietly stops offering itself.
    expect(manifest.hostEnv).toEqual(["CLAUDE_CONFIG_DIR"]);
  });

  it("declares the capabilities it implements", () => {
    expect(plugin.capabilities().sort()).toEqual(["attention", "mcp", "resume", "settings"]);
  });

  it("buildCommand: bare launch with no preset extra", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      subshellName: "",
      preset: emptyPreset(),
      reporter,
    });
    expect(cmd).toEqual(["/usr/bin/claude", "--settings", expect.any(String)]);
    expect(JSON.parse(cmd[2]).hooks).toBeDefined();
  });

  it("buildCommand: passes settings JSON, name, flags", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      subshellName: "My Subshell",
      preset: {
        name: "p",
        env: {},
        flags: ["--permission-mode", "plan", "--model", "sonnet"],
        settings: { permissionMode: "plan", model: "sonnet" },
        configIsolation: false,
      },
      reporter,
    });
    expect(cmd[0]).toBe("/usr/bin/claude");
    expect(cmd).toContain("--settings");
    const settingsIdx = cmd.indexOf("--settings");
    // The merged JSON must carry the preset's keys verbatim; `hooks` is
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
      preset: {
        name: "p",
        env: {},
        flags: ["--append-system-prompt", "be nice"],
        settings: null,
        configIsolation: false,
      },
      reporter,
    });
    expect(cmd).toEqual(["/usr/bin/claude", "--settings", expect.any(String), "--append-system-prompt", "be nice"]);
  });

  it("validatePreset: rejects missing name and bad flags", () => {
    expect(plugin.validatePreset({ name: "", env: {}, flags: [], settings: null, configIsolation: false }).valid).toBe(
      false,
    );
    const bad = plugin.validatePreset({
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

function emptyPreset(): PresetDefinition {
  return { name: "default", env: {}, flags: [], settings: null, configIsolation: false };
}

describe("ClaudeCodePlugin MCP config injection", () => {
  it("splices the registration's argv right after the binary", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      preset: { name: "P", env: {}, flags: [], settings: null, configIsolation: false },
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
      preset: { name: "P", env: {}, flags: [], settings: null, configIsolation: false },
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
      preset: emptyPreset(),
      subshellName: "",
      harnessSession: { id: "11111111-1111-4111-8111-111111111111", mode: "start" },
      reporter,
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
      preset: emptyPreset(),
      subshellName: "x",
      harnessSession: { id: "11111111-1111-4111-8111-111111111111", mode: "resume" },
      reporter,
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
      preset: emptyPreset(),
      subshellName: "",
    });
    expect(cmd).not.toContain("--resume");
    expect(cmd).not.toContain("--session-id");
  });

  describe("resume.resumePath", () => {
    // The contract is PURE (spec 2026-09-10 §5): the plugin computes where a
    // transcript WOULD be from the target machine's reported environment, and
    // never touches a filesystem or process.env itself, so the control plane
    // can build the path for a node it cannot see. These cases pass a made-up
    // home and override; what exists is the HOST's question.
    const resume = () => plugin.resume as NonNullable<typeof plugin.resume>;

    it("allocateHarnessSessionId mints a v4 uuid (the pin `--session-id` later resumes by)", () => {
      expect(resume().allocateHarnessSessionId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it("is pure and honours the target machine's override", () => {
      const p = resume().resumePath("abc", "/w/x", { homeDir: "/home/n", env: { CLAUDE_CONFIG_DIR: "/custom" } });
      expect(p).toBe("/custom/projects/-w-x/abc.jsonl");
    });

    it("falls back to the reported home when the variable is absent", () => {
      const p = resume().resumePath("abc", "/w/x", { homeDir: "/home/n", env: {} });
      expect(p).toBe("/home/n/.claude/projects/-w-x/abc.jsonl");
    });

    it("a manifest naming the wrong variable falls back to the home default, silently", () => {
      // The landmine of spec §11, documented as a permanent test.
      // `subshell.hostEnv` declares WHICH variable the node reports; a typo
      // (`CLAUDE_CONFIG_DIRR`) means the node dutifully reports a variable
      // nothing sets, so it is simply absent and the plugin's own fallback
      // applies. The resume does not throw and is not refused; it just never
      // offers itself on a machine whose real config dir is overridden. That
      // silence is why the declaration is worth reading carefully.
      const p = resume().resumePath("abc", "/w/x", { homeDir: "/home/n", env: { CLAUDE_CONFIG_DIRR: "/custom" } });
      expect(p).toBe("/home/n/.claude/projects/-w-x/abc.jsonl");
    });

    it("slugs the cwd without consulting the filesystem (dots and slashes alike)", () => {
      // A home nothing could have and a cwd nothing could contain: a member
      // that probed would throw or return false here. It does neither; the
      // string just lands where Claude would put it.
      const p = resume().resumePath("abc", "/tmp/my.project", { homeDir: "/does/not/matter", env: {} });
      expect(p).toBe("/does/not/matter/.claude/projects/-tmp-my-project/abc.jsonl");
    });

    it("trims a blank override into the home default", () => {
      // process.env could carry `CLAUDE_CONFIG_DIR=""` or spaces; the old
      // `claudeConfigDir` trimmed before deciding. Same rule on the reported
      // value: whitespace-only is "unset", not a directory named " ".
      const p = resume().resumePath("abc", "/w/x", { homeDir: "/home/n", env: { CLAUDE_CONFIG_DIR: "  " } });
      expect(p).toBe("/home/n/.claude/projects/-w-x/abc.jsonl");
    });
  });
});

describe("ClaudeCodePlugin attention hooks", () => {
  it("declares native attention-hook support", () => {
    expect(plugin.supportsAttentionHooks).toBe(true);
  });

  /** Pulls the hooks object out of a built command's --settings JSON. */
  function hooksOf(cmd: string[]): Record<string, [{ hooks: [{ command: string }] }] | undefined> {
    const idx = cmd.indexOf("--settings");
    expect(idx).toBeGreaterThan(-1);
    const settings = JSON.parse(cmd[idx + 1]) as {
      hooks?: Record<string, [{ hooks: [{ command: string }] }]>;
    };
    return settings.hooks ?? {};
  }

  it("emits Stop and Notification hooks that re-enter the reporter binary", () => {
    const hooks = hooksOf(
      plugin.buildCommand({
        binary: "/usr/bin/claude",
        cwd: "/tmp/ws",
        preset: emptyPreset(),
        subshellName: "",
        reporter,
      }),
    );

    expect(hooks.Stop?.[0].hooks[0].command).toBe(
      "'/usr/local/bin/subshell-server' 'report' 'attention' 'turn_complete'",
    );
    expect(hooks.Notification?.[0].hooks[0].command).toBe(
      "'/usr/local/bin/subshell-server' 'report' 'attention' 'needs_attention'",
    );
  });

  it("narrows the Notification hook to the types that genuinely need a human", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      preset: emptyPreset(),
      subshellName: "",
      reporter,
    });
    const idx = cmd.indexOf("--settings");
    expect(idx).toBeGreaterThan(-1);
    const settings = JSON.parse(cmd[idx + 1]) as {
      hooks?: Record<string, [{ matcher?: string; hooks: [{ command: string }] }]>;
    };
    // Without the matcher EVERY notification type rings "Needs your
    // approval": idle_prompt, auth_success, the quota_auto_resume_* family,
    // and elicitation_complete after the human already answered (spec
    // 2026-09-23). This string is the whole filter, so it is pinned exactly.
    expect(settings.hooks?.Notification?.[0]?.matcher).toBe(
      "permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog",
    );
  });

  /**
   * The regression this whole path exists for: the hooks used to be
   * `bun -e '<inlined JS>'`, which assumed a bun on the pane PATH. True of the
   * container image the assumption was written for, false of every desktop
   * install — where Claude Code opened with `/bin/sh: bun: command not found`
   * and neither notifications nor conversation identity ever worked.
   */
  it("names NO interpreter: a pane's machine is only guaranteed to have this binary", () => {
    const hooks = hooksOf(
      plugin.buildCommand({
        binary: "/usr/bin/claude",
        cwd: "/tmp/ws",
        preset: emptyPreset(),
        subshellName: "",
        reporter,
      }),
    );

    for (const event of Object.keys(hooks)) {
      const command = hooks[event]?.[0].hooks[0].command ?? "";
      expect(command.startsWith("'/usr/local/bin/subshell-server' 'report' ")).toBe(true);
      expect(command).not.toContain("bun");
      expect(command).not.toContain("fetch(");
    }
  });

  it("carries an interpreted reporter's entry script through, quoted", () => {
    const hooks = hooksOf(
      plugin.buildCommand({
        binary: "/usr/bin/claude",
        cwd: "/tmp/ws",
        preset: emptyPreset(),
        subshellName: "",
        reporter: { command: "/usr/local/bin/bun", args: ["/opt/my subshell/index.ts", "report"] },
      }),
    );

    expect(hooks.Stop?.[0].hooks[0].command).toBe(
      "'/usr/local/bin/bun' '/opt/my subshell/index.ts' 'report' 'attention' 'turn_complete'",
    );
  });

  it("omits the hooks entirely when no reporter resolved — never a command the pane cannot run", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      preset: emptyPreset(),
      subshellName: "",
    });

    expect(cmd).not.toContain("--settings");
  });

  it("preset settings survive the merge (hooks added alongside, not replacing)", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      preset: { name: "p", env: {}, flags: [], settings: { model: "sonnet" }, configIsolation: false },
      subshellName: "",
      reporter,
    });
    const settings = JSON.parse(cmd[cmd.indexOf("--settings") + 1]) as Record<string, unknown>;
    expect(settings.model).toBe("sonnet");
    expect(settings.hooks).toBeDefined();
  });

  it("keeps a preset's own settings when no reporter resolved, minus the hooks", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      preset: { name: "p", env: {}, flags: [], settings: { model: "sonnet" }, configIsolation: false },
      subshellName: "",
    });
    const settings = JSON.parse(cmd[cmd.indexOf("--settings") + 1]) as Record<string, unknown>;
    expect(settings.model).toBe("sonnet");
    expect(settings.hooks).toBeUndefined();
  });

  it("SessionStart reports the pane's current conversation id through the reporter", () => {
    const hooks = hooksOf(
      plugin.buildCommand({
        binary: "/usr/bin/claude",
        cwd: "/tmp/ws",
        preset: emptyPreset(),
        subshellName: "",
        reporter,
      }),
    );

    // The verb alone — WHICH field of the stdin payload is forwarded, and the
    // bounds on reading it, are the reporter's contract now (mcp-core's
    // `report.ts`), not something re-decided per plugin in an inlined script.
    expect(hooks.SessionStart?.[0].hooks[0].command).toBe("'/usr/local/bin/subshell-server' 'report' 'session'");
  });
});
