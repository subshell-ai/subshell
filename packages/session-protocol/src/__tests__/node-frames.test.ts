import { describe, expect, it } from "bun:test";
import { NODE_PROTOCOL_VERSION, parseNodeCommandBody, parseNodeEvent } from "../node-frames.js";

const launchCmd = {
  type: "launch",
  sessionId: "s1",
  socket: "mote-abc",
  cwd: "/home/u/repo",
  harnessId: "claude-code",
  profile: { name: "P", env: { A: "b" }, flags: [], settings: null, configIsolation: false },
  moteEnv: { MOTE_API_KEY: "mote_x" },
  sessionName: "s1",
  harnessSession: { id: "h1", mode: "start" as const },
};

describe("parseNodeCommandBody", () => {
  it("accepts a well-formed launch and preserves fields", () => {
    const cmd = parseNodeCommandBody(structuredClone(launchCmd));
    expect(cmd).not.toBeNull();
    expect(cmd?.type).toBe("launch");
    if (cmd?.type === "launch") {
      expect(cmd.cwd).toBe("/home/u/repo");
      expect(cmd.socket).toBe("mote-abc");
      expect(cmd.profile.name).toBe("P");
    }
  });

  it("rejects non-positive launch geometry and prompt timings", () => {
    expect(parseNodeCommandBody({ ...launchCmd, cols: 0 })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, rows: 0 })).toBeNull();
    expect(
      parseNodeCommandBody({ type: "prompt_deliver", sessionId: "s", text: "hi", settleTimeoutMs: 5000, pollMs: 0 }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({ type: "prompt_deliver", sessionId: "s", text: "hi", settleTimeoutMs: -1, pollMs: 250 }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({ type: "prompt_deliver", sessionId: "s", text: "hi", settleTimeoutMs: 5000, pollMs: 250 }),
    ).not.toBeNull();
  });

  it("accepts an explicit undefined profile description (absent-like)", () => {
    const cmd = structuredClone(launchCmd) as Record<string, unknown>;
    (cmd.profile as Record<string, unknown>).description = undefined;
    expect(parseNodeCommandBody(cmd)).not.toBeNull();
  });

  it("validates the remaining command variants", () => {
    expect(parseNodeCommandBody({ type: "log_read", sessionId: "s", fromByte: 0, maxBytes: 100 })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "log_read", sessionId: "s", fromByte: -1, maxBytes: 100 })).toBeNull();
    expect(parseNodeCommandBody({ type: "tail_start", sessionId: "s", subId: "t", fromByte: 0 })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "tail_start", sessionId: "s", subId: "t", fromByte: -1 })).toBeNull();
    expect(parseNodeCommandBody({ type: "stat_dir", path: "/x" })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "stat_dir" })).toBeNull();
    expect(parseNodeCommandBody({ type: "probe", sessionIds: ["a"] })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "probe", sessionIds: ["a", 1] as unknown[] })).toBeNull();
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
    expect(parseNodeCommandBody({ type: "capture", sessionId: "s" })).toEqual({ type: "capture", sessionId: "s" });
    expect(parseNodeCommandBody({ type: "capture", sessionId: "s", lines: 100 })).toEqual({
      type: "capture",
      sessionId: "s",
      lines: 100,
    });
    expect(parseNodeCommandBody({ type: "capture", sessionId: "s", lines: 0 })).toBeNull();
    expect(parseNodeCommandBody({ type: "capture", sessionId: "s", lines: 1.5 })).toBeNull();
    expect(parseNodeCommandBody({ type: "capture", sessionId: "s", lines: "100" })).toBeNull();
  });

  it("accepts input/resize/terminate/ping and checks their required fields", () => {
    expect(parseNodeCommandBody({ type: "ping" })).toEqual({ type: "ping" });
    expect(parseNodeCommandBody({ type: "input", sessionId: "s", data: "" })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "input", sessionId: "s" })).toBeNull();
    expect(parseNodeCommandBody({ type: "resize", sessionId: "s", cols: 80, rows: 24 })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "resize", sessionId: "s", cols: 0, rows: 24 })).toBeNull();
    expect(parseNodeCommandBody({ type: "terminate", sessionId: "s" })).not.toBeNull();
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

  it("pins the protocol version constant", () => {
    expect(NODE_PROTOCOL_VERSION).toBe(1);
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
    const good = { type: "output", sessionId: "s", subId: "t1", fromByte: 0, toByte: 3, data_b64: "aGk=" };
    expect(parseNodeEvent(good)).not.toBeNull();
    expect(parseNodeEvent({ ...good, fromByte: 5, toByte: 3 })).toBeNull();
    expect(parseNodeEvent({ ...good, data_b64: "%%%" })).toBeNull();
  });

  it("parses result ok/error, exit, heartbeat, sessions_report, error; rejects garbage", () => {
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: true })?.type).toBe("result");
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: false, error: "nope" })?.type).toBe("result");
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: false })).toBeNull();
    expect(parseNodeEvent({ type: "heartbeat", ts: "t" })?.type).toBe("heartbeat");
    expect(parseNodeEvent({ type: "exit", sessionId: "s", exitCode: 1, at: "t" })?.type).toBe("exit");
    expect(parseNodeEvent({ type: "sessions_report", sessions: [] })?.type).toBe("sessions_report");
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
