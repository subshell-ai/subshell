import { describe, expect, it } from "bun:test";
import {
  NODE_CLOSE_SUPERSEDED,
  NODE_CLOSE_UPDATE_REQUIRED,
  parseNodeCaptureResult,
  parseNodeCommandBody,
  parseNodeEvent,
  parseNodeLogReadResult,
  parseNodeProbeEntries,
  parseNodeProbeResume,
  parseNodePromptDeliver,
  parseNodeStatDirResult,
  parseNodeWriteFileResult,
} from "../index.js";

describe("node result contracts (spec §3.3, phase-2 wire note)", () => {
  it("hoists the two shared close codes", () => {
    expect(NODE_CLOSE_UPDATE_REQUIRED).toBe(4406);
    expect(NODE_CLOSE_SUPERSEDED).toBe(4409);
  });

  it("probe entries: accept well-formed (incl. optional fields), reject junk", () => {
    expect(
      parseNodeProbeEntries([
        { sessionId: "a", alive: true, exitCode: null },
        { sessionId: "b", alive: false, exitCode: 1, title: "t", command: "c", capture: "screen" },
      ]),
    ).toHaveLength(2);
    expect(parseNodeProbeEntries(null)).toBeNull();
    expect(parseNodeProbeEntries([{ sessionId: "a" }])).toBeNull(); // alive missing
    expect(parseNodeProbeEntries([{ sessionId: "a", alive: true, exitCode: 1.5 }])).toBeNull();
    expect(parseNodeProbeEntries([{ sessionId: "a", alive: true, exitCode: null, title: 7 }])).toBeNull();
  });

  it("log_read requires a strict-base64 payload and monotonic offsets", () => {
    expect(parseNodeLogReadResult({ bytes_b64: "aGk=", next: 2, size: 2 })).not.toBeNull();
    expect(parseNodeLogReadResult({ bytes_b64: "!!", next: 0, size: 1 })).toBeNull();
    expect(parseNodeLogReadResult({ bytes_b64: "", next: 5, size: 3 })).toBeNull(); // empty read must not jump past EOF
    expect(parseNodeLogReadResult({ bytes_b64: "", next: 3, size: 3 })).not.toBeNull(); // empty tail read is legal
    expect(parseNodeLogReadResult({ bytes_b64: "aGk=", next: -1, size: 2 })).toBeNull();
  });

  it("the scalar results validate narrowly", () => {
    expect(parseNodeCaptureResult("screen")).toBe("screen");
    expect(parseNodeCaptureResult(42)).toBeNull();
    expect(parseNodeStatDirResult({ path: "/x", isDirectory: true })).not.toBeNull();
    expect(parseNodeStatDirResult({ path: "/x", isDirectory: "yes" })).toBeNull();
    expect(parseNodePromptDeliver({ promptDelivered: false })).not.toBeNull();
    expect(parseNodePromptDeliver({})).toBeNull();
    expect(parseNodeProbeResume({ canResume: true })).not.toBeNull();
    expect(parseNodeProbeResume({ canResume: null })).toBeNull();
    expect(parseNodeWriteFileResult({ path: "/x", received: 12 })).not.toBeNull();
    expect(parseNodeWriteFileResult({ path: "", received: 0 })).toBeNull();
  });
});

describe("phase-2 additive frame fields (protocol stays v1)", () => {
  const launchCmd = {
    type: "launch",
    sessionId: "s1",
    socket: "mote-abc",
    cwd: "/home/u/repo",
    harnessId: "claude-code",
    profile: { name: "P", env: {}, flags: [], settings: null, configIsolation: false },
    moteEnv: { MOTE_API_KEY: "mote_x" },
    sessionName: "s1",
  };

  it("launch.bestEffortLog is an optional boolean", () => {
    expect(parseNodeCommandBody({ ...launchCmd, bestEffortLog: true })).not.toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, bestEffortLog: false })).not.toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, bestEffortLog: "yes" })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd })).not.toBeNull(); // absent ⇒ today's behavior
  });

  it("ready.executablePath is an optional string", () => {
    const ready = {
      type: "ready",
      agentVersion: "0.2.0",
      protocolVersion: 1,
      os: "linux",
      arch: "x64",
      hostname: "box",
      dataDir: "/home/u/.local/share/subshell",
      capabilities: [],
    };
    expect(parseNodeEvent({ ...ready, executablePath: "/usr/local/bin/subshell" })?.type).toBe("ready");
    expect(parseNodeEvent(ready)?.type).toBe("ready"); // pre-phase-2 agent omits it
    expect(parseNodeEvent({ ...ready, executablePath: 42 })).toBeNull();
  });
});
