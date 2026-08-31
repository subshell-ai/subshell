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
      dataDir: "/Users/u/.local/share/mote-agent",
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
});
