import { describe, expect, it } from "bun:test";
import { NODE_PROTOCOL_VERSION, parseNodeCommandBody, parseNodeEvent } from "../node-frames.js";

const launchCmd = {
  type: "launch",
  subshellId: "s1",
  socket: "subshell-abc",
  cwd: "/home/u/repo",
  harnessId: "claude-code",
  profile: { name: "P", env: { A: "b" }, flags: [], settings: null, configIsolation: false },
  subshellEnv: { SUBSHELL_API_KEY: "subshell_x" },
  subshellName: "s1",
  harnessSession: { id: "h1", mode: "start" as const },
};

describe("parseNodeCommandBody", () => {
  it("accepts a well-formed launch and preserves fields", () => {
    const cmd = parseNodeCommandBody(structuredClone(launchCmd));
    expect(cmd).not.toBeNull();
    expect(cmd?.type).toBe("launch");
    if (cmd?.type === "launch") {
      expect(cmd.cwd).toBe("/home/u/repo");
      expect(cmd.socket).toBe("subshell-abc");
      expect(cmd.profile.name).toBe("P");
    }
  });

  it("rejects non-positive launch geometry and prompt timings", () => {
    expect(parseNodeCommandBody({ ...launchCmd, cols: 0 })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, rows: 0 })).toBeNull();
    expect(
      parseNodeCommandBody({ type: "prompt_deliver", subshellId: "s", text: "hi", settleTimeoutMs: 5000, pollMs: 0 }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({ type: "prompt_deliver", subshellId: "s", text: "hi", settleTimeoutMs: -1, pollMs: 250 }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({ type: "prompt_deliver", subshellId: "s", text: "hi", settleTimeoutMs: 5000, pollMs: 250 }),
    ).not.toBeNull();
  });

  it("accepts an explicit undefined profile description (absent-like)", () => {
    const cmd = structuredClone(launchCmd) as Record<string, unknown>;
    (cmd.profile as Record<string, unknown>).description = undefined;
    expect(parseNodeCommandBody(cmd)).not.toBeNull();
  });

  it("validates the remaining command variants", () => {
    expect(parseNodeCommandBody({ type: "log_read", subshellId: "s", fromByte: 0, maxBytes: 100 })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "log_read", subshellId: "s", fromByte: -1, maxBytes: 100 })).toBeNull();
    expect(parseNodeCommandBody({ type: "tail_start", subshellId: "s", subId: "t", fromByte: 0 })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "tail_start", subshellId: "s", subId: "t", fromByte: -1 })).toBeNull();
    expect(parseNodeCommandBody({ type: "stat_dir", path: "/x" })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "stat_dir" })).toBeNull();
    // fs_ls: the path gate is stat_dir's — a string, emptiness
    // legal (agent-home); absoluteness is enforced agent-side, not on the wire.
    expect(parseNodeCommandBody({ type: "fs_ls", path: "/x" })).toEqual({ type: "fs_ls", path: "/x" });
    expect(parseNodeCommandBody({ type: "fs_ls", path: "" })).toEqual({ type: "fs_ls", path: "" });
    expect(parseNodeCommandBody({ type: "fs_ls" })).toBeNull();
    expect(parseNodeCommandBody({ type: "fs_ls", path: 7 })).toBeNull();
    expect(parseNodeCommandBody({ type: "probe", subshellIds: ["a"] })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "probe", subshellIds: ["a", 1] as unknown[] })).toBeNull();
    expect(parseNodeCommandBody({ type: "remove_paths", paths: [] })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "inventory" })).toEqual({ type: "inventory" });
    expect(parseNodeCommandBody({ type: "ping" })).toEqual({ type: "ping" });
  });

  it("rejects launch with a malformed profile (env value not a string)", () => {
    const bad = structuredClone(launchCmd) as Record<string, unknown>;
    (bad.profile as Record<string, unknown>).env = { A: 1 };
    expect(parseNodeCommandBody(bad)).toBeNull();
  });

  it("rejects unknown command types, non-objects, and JSON garbage", () => {
    expect(parseNodeCommandBody({ type: "reboot" })).toBeNull();
    expect(parseNodeCommandBody(null)).toBeNull();
    expect(parseNodeCommandBody("[]")).toBeNull();
    expect(parseNodeCommandBody({})).toBeNull();
  });

  it("capture: optional positive-int `lines` passes through; garbage is refused", () => {
    expect(parseNodeCommandBody({ type: "capture", subshellId: "s" })).toEqual({ type: "capture", subshellId: "s" });
    expect(parseNodeCommandBody({ type: "capture", subshellId: "s", lines: 100 })).toEqual({
      type: "capture",
      subshellId: "s",
      lines: 100,
    });
    expect(parseNodeCommandBody({ type: "capture", subshellId: "s", lines: 0 })).toBeNull();
    expect(parseNodeCommandBody({ type: "capture", subshellId: "s", lines: 1.5 })).toBeNull();
    expect(parseNodeCommandBody({ type: "capture", subshellId: "s", lines: "100" })).toBeNull();
  });

  it("accepts input/resize/terminate/ping and checks their required fields", () => {
    expect(parseNodeCommandBody({ type: "ping" })).toEqual({ type: "ping" });
    expect(parseNodeCommandBody({ type: "input", subshellId: "s", data: "" })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "input", subshellId: "s" })).toBeNull();
    expect(parseNodeCommandBody({ type: "resize", subshellId: "s", cols: 80, rows: 24 })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "resize", subshellId: "s", cols: 0, rows: 24 })).toBeNull();
    expect(parseNodeCommandBody({ type: "terminate", subshellId: "s" })).not.toBeNull();
  });

  it("validates write_file chunk bounds and base64 payloads", () => {
    expect(
      parseNodeCommandBody({ type: "write_file", path: "/d/x", chunk_b64: "aGk=", chunk: 0, eof: true }),
    ).not.toBeNull();
    expect(
      parseNodeCommandBody({ type: "write_file", path: "/d/x", chunk_b64: "not base64!!", chunk: 0, eof: false }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({ type: "write_file", path: "/d/x", chunk_b64: "aGk=", chunk: -1, eof: false }),
    ).toBeNull();
  });

  it("pins the protocol version", () => {
    // Matched EXACTLY: there is no compat window and no per-feature gating,
    // because the server and the agent ship together. Bump this whenever a
    // frame changes and release both sides. (2 is phase 3's bump — the
    // registry spec on `plugin_install` — and the first REAL one: the
    // numbering restarted at 1 on 2026-09-09 with no deployed instances.)
    expect(NODE_PROTOCOL_VERSION).toBe(2);
  });

  it("accepts set_allowed_dirs and rejects a missing or non-array dirs", () => {
    // The parser checks SHAPE only — normalization is the
    // executor's job, so one malformed entry inside a well-formed array must
    // not reject the whole push and leave the node on stale rules.
    expect(parseNodeCommandBody({ type: "set_allowed_dirs", dirs: ["/a", "/b"] })).toEqual({
      type: "set_allowed_dirs",
      dirs: ["/a", "/b"],
    });
    // Empty is meaningful: it CLEARS the rules (unrestricted), so it must parse.
    expect(parseNodeCommandBody({ type: "set_allowed_dirs", dirs: [] })).toEqual({
      type: "set_allowed_dirs",
      dirs: [],
    });
    expect(parseNodeCommandBody({ type: "set_allowed_dirs" })).toBeNull();
    expect(parseNodeCommandBody({ type: "set_allowed_dirs", dirs: "/a" })).toBeNull();
    expect(parseNodeCommandBody({ type: "set_allowed_dirs", dirs: [1, 2] })).toBeNull();
  });

  it("accepts pane_size and rejects a missing or non-string id", () => {
    expect(parseNodeCommandBody({ type: "pane_size", subshellId: "s1" })).toEqual({
      type: "pane_size",
      subshellId: "s1",
    });
    expect(parseNodeCommandBody({ type: "pane_size" })).toBeNull();
    expect(parseNodeCommandBody({ type: "pane_size", subshellId: 7 })).toBeNull();
  });
});

describe("parseNodeEvent", () => {
  it("accepts ready with capabilities and parses inventory", () => {
    const ev = parseNodeEvent({
      type: "ready",
      agentVersion: "0.1.0",
      protocolVersion: 1,
      os: "darwin",
      arch: "arm64",
      hostname: "mac-mini",
      dataDir: "/Users/u/.local/share/subshell",
      capabilities: ["mcp"],
    });
    expect(ev?.type).toBe("ready");
    const inv = parseNodeEvent(
      JSON.stringify({
        type: "inventory",
        ts: "2026-08-31T00:00:00Z",
        harnesses: [{ harnessId: "claude-code", installed: true, version: "2.1", binaryPath: "/usr/bin/claude" }],
      }),
    );
    expect(inv?.type).toBe("inventory");
  });

  it("rejects non-positive byte ranges and bad base64 on output", () => {
    const good = { type: "output", subshellId: "s", subId: "t1", fromByte: 0, toByte: 3, data_b64: "aGk=" };
    expect(parseNodeEvent(good)).not.toBeNull();
    expect(parseNodeEvent({ ...good, fromByte: 5, toByte: 3 })).toBeNull();
    expect(parseNodeEvent({ ...good, data_b64: "%%%" })).toBeNull();
  });

  it("parses result ok/error, exit, heartbeat, subshells_report, error; rejects garbage", () => {
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: true })?.type).toBe("result");
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: false, error: "nope" })?.type).toBe("result");
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: false })).toBeNull();
    expect(parseNodeEvent({ type: "heartbeat", ts: "t" })?.type).toBe("heartbeat");
    expect(parseNodeEvent({ type: "exit", subshellId: "s", exitCode: 1, at: "t" })?.type).toBe("exit");
    expect(parseNodeEvent({ type: "subshells_report", subshells: [] })?.type).toBe("subshells_report");
    expect(parseNodeEvent({ type: "error", code: "x", message: "y" })?.type).toBe("error");
    expect(parseNodeEvent("nope")).toBeNull();
    expect(parseNodeEvent({ type: "chat", text: "hi" })).toBeNull();
  });

  it("omits data on ok:true results unless present, and validates it when present", () => {
    const ev = parseNodeEvent({ type: "result", ref: "j1", ok: true });
    expect(ev?.type).toBe("result");
    expect("data" in (ev as object)).toBe(false);
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: true, data: { x: [1, "a", null] } })).not.toBeNull();
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: true, data: undefined })).toBeNull();
  });
});

describe("plugin commands", () => {
  it("accepts plugin_install and plugin_uninstall with an id", () => {
    expect(parseNodeCommandBody({ type: "plugin_install", id: "claude-code" })).toEqual({
      type: "plugin_install",
      id: "claude-code",
    });
    expect(parseNodeCommandBody({ type: "plugin_uninstall", id: "pi" })).toEqual({
      type: "plugin_uninstall",
      id: "pi",
    });
  });

  it("rejects a missing or non-string id", () => {
    for (const body of [
      { type: "plugin_install" },
      { type: "plugin_install", id: 7 },
      { type: "plugin_uninstall", id: null },
    ]) {
      expect(parseNodeCommandBody(body)).toBeNull();
    }
  });

  it("checks SHAPE only, leaving whether the id is installable to the node", () => {
    // The node answers with a message naming the plugin, which is more useful
    // than a parser rejecting the frame with no context.
    expect(parseNodeCommandBody({ type: "plugin_install", id: "not-a-real-plugin" })).toEqual({
      type: "plugin_install",
      id: "not-a-real-plugin",
    });
  });
  it("accepts an optional spec alongside the id (phase 3)", () => {
    expect(
      parseNodeCommandBody({ type: "plugin_install", id: "codex", spec: "@subshell-ai/plugin-codex@2.0.0" }),
    ).toEqual({ type: "plugin_install", id: "codex", spec: "@subshell-ai/plugin-codex@2.0.0" });
    // Absent stays absent — the byte-identical v1 shape.
    expect(parseNodeCommandBody({ type: "plugin_install", id: "pi" })).toEqual({ type: "plugin_install", id: "pi" });
  });
  it("rejects a non-string spec rather than coercing", () => {
    expect(parseNodeCommandBody({ type: "plugin_install", id: "pi", spec: 3 })).toBeNull();
    expect(parseNodeCommandBody({ type: "plugin_install", id: "pi", spec: "" })).toBeNull();
  });
});
