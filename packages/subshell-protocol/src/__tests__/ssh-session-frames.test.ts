/**
 * Grammar tests for the session-runtime family (design 2026-10-05 §2/§3):
 * parse round-trips for every new arm, refusals at the boundaries the plane
 * and the runtime both rely on, and the fold-ins into the shared command and
 * event parsers.
 */
import { describe, expect, test } from "bun:test";
import {
  encodeSshSessionFrame,
  isSshSessionRef,
  type NodeEvent,
  parseNodeCommandBody,
  parseNodeEvent,
  parseNodeSshSessionOpenResult,
  parseSshRuntimeCommandFrame,
  parseSshRuntimeEventFrame,
  parseSshRuntimeHello,
  parseSshRuntimeReportRows,
  parseSshSessionNodeCommandBody,
  parseSshSessionOpenResult,
  parseSshSessionTarget,
  SSH_RUNTIME_PROTOCOL,
  SSH_SESSION_FRAME_MAX_BYTES,
  type SshRuntimeEventFrame,
  type SshRuntimeHelloWire,
  SshSessionFrameDecoder,
  type SshSessionNodeCommandBody,
  type SshSessionTargetWire,
  sshRuntimeProtocolSupported,
} from "../index.js";

const ref = "0f4c1a7e-9b62-4a11-8d3e-5c2b1a0f9e8d";

function validTarget(): SshSessionTargetWire {
  return {
    alias: "e2edest",
    host: "127.0.0.1",
    port: 2222,
    user: "theo",
    identityFile: "/home/theo/.ssh/id_ed25519",
  };
}

function validHello(): SshRuntimeHelloWire {
  return {
    type: "hello",
    runtimeProtocol: SSH_RUNTIME_PROTOCOL,
    agentVersion: "1.5.0",
    os: "linux",
    arch: "x64",
    capabilities: ["panes", "callback-sock"],
    homeDir: "/home/theo",
    dataDir: "/home/theo/.local/share/subshell/runtime",
    tmuxSocket: "subshell-ssh-ab12cd34ef56",
    paneCount: 2,
  };
}

describe("parseSshSessionTarget", () => {
  test("accepts the full shape and rebuilds it", () => {
    const t = parseSshSessionTarget(validTarget());
    expect(t).toEqual(validTarget());
  });
  test("null user and null identityFile are explicit and legal", () => {
    const t = parseSshSessionTarget({ ...validTarget(), user: null, identityFile: null });
    expect(t?.user).toBeNull();
    expect(t?.identityFile).toBeNull();
  });
  test("refuses option-like hosts, zero/overflow ports, control chars, relative identity", () => {
    expect(parseSshSessionTarget({ ...validTarget(), host: "-oProxyCommand=x" })).toBeNull();
    expect(parseSshSessionTarget({ ...validTarget(), port: 0 })).toBeNull();
    expect(parseSshSessionTarget({ ...validTarget(), port: 70000 })).toBeNull();
    expect(parseSshSessionTarget({ ...validTarget(), user: "a\nb" })).toBeNull();
    expect(parseSshSessionTarget({ ...validTarget(), identityFile: ".ssh/id" })).toBeNull();
  });
});

describe("parseSshSessionNodeCommandBody", () => {
  test("open round-trips through the shared command parser", () => {
    const cmd = {
      type: "ssh_session_open",
      ref,
      target: validTarget(),
      runtimeCommand: "/opt/wrap/subshell",
    } satisfies SshSessionNodeCommandBody;
    const parsed = parseSshSessionNodeCommandBody(cmd);
    expect(parsed).toEqual(cmd);
    expect(parseNodeCommandBody(JSON.stringify(cmd))).toEqual(cmd);
  });
  test("open without runtimeCommand omits the key (the default lives in the broker)", () => {
    const parsed = parseSshSessionNodeCommandBody({ type: "ssh_session_open", ref, target: validTarget() });
    expect(parsed && "runtimeCommand" in parsed).toBe(false);
  });
  test("open refuses junk refs, bad base64 send payloads, and option-like runtimeCommand", () => {
    expect(
      parseSshSessionNodeCommandBody({ type: "ssh_session_open", ref: "not base64url!", target: validTarget() }),
    ).toBeNull();
    expect(parseSshSessionNodeCommandBody({ type: "ssh_session_send", ref, data_b64: "%%%!" })).toBeNull();
    const bad = parseSshSessionNodeCommandBody({
      type: "ssh_session_open",
      ref,
      target: validTarget(),
      runtimeCommand: "--upload-proxy",
    });
    expect(bad).toBeNull();
    const spaced = parseSshSessionNodeCommandBody({
      type: "ssh_session_open",
      ref,
      target: validTarget(),
      runtimeCommand: "subshell; rm -rf /",
    });
    expect(spaced).toBeNull();
  });
  test("send round-trips with empty payload; close needs only the ref", () => {
    expect(parseSshSessionNodeCommandBody({ type: "ssh_session_send", ref, data_b64: "" })).toEqual({
      type: "ssh_session_send",
      ref,
      data_b64: "",
    });
    expect(parseSshSessionNodeCommandBody({ type: "ssh_session_close", ref })).toEqual({
      type: "ssh_session_close",
      ref,
    });
  });
});

describe("parseNodeEvent session_frame arm", () => {
  test("round-trips the pump chunk", () => {
    const ev = { type: "session_frame", ref, data_b64: Buffer.from("hi").toString("base64") } satisfies NodeEvent;
    expect(parseNodeEvent(JSON.stringify(ev))).toEqual(ev);
  });
  test("refuses non-base64 payloads, empty refs, and path-shaped refs", () => {
    expect(parseNodeEvent({ type: "session_frame", ref, data_b64: "!!!" })).toBeNull();
    expect(parseNodeEvent({ type: "session_frame", ref: "", data_b64: "" })).toBeNull();
    expect(parseNodeEvent({ type: "session_frame", ref: "../escape", data_b64: "" })).toBeNull();
  });
});

describe("hello + open result", () => {
  test("hello round-trips; major mismatch names itself via sshRuntimeProtocolSupported", () => {
    const h = parseSshRuntimeHello(validHello());
    expect(h).toEqual(validHello());
    expect(h && sshRuntimeProtocolSupported(h)).toBe(true);
    const other = parseSshRuntimeHello({ ...validHello(), runtimeProtocol: 99 });
    expect(other && sshRuntimeProtocolSupported(other)).toBe(false);
    expect(parseSshRuntimeHello({ ...validHello(), paneCount: -1 })).toBeNull();
    expect(parseSshRuntimeHello({ ...validHello(), tmuxSocket: "with space" })).toBeNull();
  });
  test("open result requires the whole hello and echoes the destination", () => {
    const openResult = {
      hello: validHello(),
      host: "127.0.0.1",
      port: 2222,
      user: "theo",
      connectingAccount: "nodehost",
    };
    expect(parseSshSessionOpenResult(openResult)).toEqual(openResult);
    expect(parseNodeSshSessionOpenResult({ ...openResult, hello: { ...validHello(), agentVersion: "" } })).toBeNull();
    expect(parseSshSessionOpenResult({ ...openResult, user: undefined })).toBeNull();
  });
});

describe("runtime command frames", () => {
  test("launch carries the node link body verbatim (shallow envelope check here)", () => {
    const body = { type: "launch", subshellId: "s-1", socket: "subshell-x", cwd: "/tmp", harnessId: "terminal" };
    const frame = { type: "launch", ref, cmd: body };
    expect(parseSshRuntimeCommandFrame(frame)?.type).toBe("launch");
    expect(parseSshRuntimeCommandFrame({ type: "launch", ref, cmd: { type: "input" } })).toBeNull();
  });
  test("input/terminate/probe/tail arms round-trip", () => {
    expect(parseSshRuntimeCommandFrame({ type: "input", ref, subshellId: "s", data: "ls\r" })).toEqual({
      type: "input",
      ref,
      subshellId: "s",
      data: "ls\r",
    });
    expect(parseSshRuntimeCommandFrame({ type: "probe", ref, subshellIds: ["a", "b"] })).not.toBeNull();
    expect(
      parseSshRuntimeCommandFrame({ type: "tail_start", ref, subshellId: "s", subId: "t", fromByte: 0 }),
    ).not.toBeNull();
    expect(parseSshRuntimeCommandFrame({ type: "tail_stop", ref, subId: "t" })).not.toBeNull();
    expect(parseSshRuntimeCommandFrame({ type: "subshells_report", ref })).not.toBeNull();
  });
  test("rest_response validates status and body shape", () => {
    expect(parseSshRuntimeCommandFrame({ type: "rest_response", reqId: "r1", status: 200, body: "{}" })).toEqual({
      type: "rest_response",
      reqId: "r1",
      status: 200,
      body: "{}",
    });
    expect(parseSshRuntimeCommandFrame({ type: "rest_response", reqId: "r1", status: 99 })).toBeNull();
    expect(parseSshRuntimeCommandFrame({ type: "rest_response", reqId: "r1", status: 200, body: 5 })).toBeNull();
  });
  test("list_dirs/stat_dir/remove_paths/close round-trip; unknown types refuse", () => {
    expect(parseSshRuntimeCommandFrame({ type: "list_dirs", ref, path: "" })).not.toBeNull();
    expect(parseSshRuntimeCommandFrame({ type: "stat_dir", ref, path: "/tmp" })).not.toBeNull();
    expect(parseSshRuntimeCommandFrame({ type: "stat_dir", ref, path: "tmp" })).toBeNull();
    expect(parseSshRuntimeCommandFrame({ type: "remove_paths", ref, paths: ["/a/b"] })).not.toBeNull();
    expect(parseSshRuntimeCommandFrame({ type: "remove_paths", ref, paths: ["b"] })).toBeNull();
    expect(parseSshRuntimeCommandFrame({ type: "close", ref })).toEqual({ type: "close", ref });
    expect(parseSshRuntimeCommandFrame({ type: "teleport", ref })).toBeNull();
  });
});

describe("runtime event frames", () => {
  test("result ok/error arms, output, exit, subshells_report, rest_request round-trip", () => {
    expect(parseSshRuntimeEventFrame({ type: "result", ref, ok: true, data: { n: 1 } })).toEqual({
      type: "result",
      ref,
      ok: true,
      data: { n: 1 },
    });
    expect(parseSshRuntimeEventFrame({ type: "result", ref, ok: false, error: "nope" })).not.toBeNull();
    expect(
      parseSshRuntimeEventFrame({
        type: "output",
        subshellId: "s",
        subId: "t",
        fromByte: 0,
        toByte: 3,
        data_b64: Buffer.from("abc").toString("base64"),
      }),
    ).not.toBeNull();
    expect(
      parseSshRuntimeEventFrame({ type: "exit", subshellId: "s", exitCode: null, at: "2026-10-05T00:00:00Z" }),
    ).not.toBeNull();
    expect(
      parseSshRuntimeEventFrame({
        type: "subshells_report",
        subshells: [{ subshellId: "s", alive: true, exitCode: null }],
      }),
    ).not.toBeNull();
    const rr = {
      type: "rest_request",
      reqId: "q",
      method: "post",
      path: "/api/subshells/s/input",
      body: "{}",
    } as const satisfies SshRuntimeEventFrame;
    const parsed = parseSshRuntimeEventFrame(rr);
    // The method is uppercased at the parse: the allowlist matcher compares
    // one spelling and a frame must not smuggle lowercase past it.
    expect(parsed).toEqual({ ...rr, method: "POST" });
    expect(parseSshRuntimeEventFrame({ type: "rest_request", reqId: "q", method: "GET", path: "relative" })).toBeNull();
  });
  test("malformed variants refuse across every arm", () => {
    expect(parseSshRuntimeEventFrame({ type: "result", ref: "!", ok: true })).toBeNull();
    expect(parseSshRuntimeEventFrame({ type: "unknown_thing" })).toBeNull();
    expect(parseSshRuntimeEventFrame({ type: "exit", subshellId: "s", exitCode: 1.5, at: "x" })).toBeNull();
  });
});

describe("framing codec", () => {
  test("single frame round-trips exactly", () => {
    const frame = { hello: "world", n: 1 };
    const bytes = encodeSshSessionFrame(frame);
    const d = new SshSessionFrameDecoder();
    expect(d.push(bytes)).toEqual([frame]);
    expect(d.failed).toBeNull();
  });
  test("frames split across pushes reassemble in order", () => {
    const a = encodeSshSessionFrame({ i: 1 });
    const b = encodeSshSessionFrame({ i: 2 });
    const all = new Uint8Array(a.byteLength + b.byteLength);
    all.set(a, 0);
    all.set(b, a.byteLength);
    const d = new SshSessionFrameDecoder();
    const out: unknown[] = [];
    // byte-at-a-time push: the pathological chunking a real ssh stdout can produce
    for (const byte of all) out.push(...d.push(new Uint8Array([byte])));
    expect(out).toEqual([{ i: 1 }, { i: 2 }]);
    expect(d.failed).toBeNull();
  });
  test("oversize declared length fails the decoder before any body byte", () => {
    const lying = new Uint8Array(4);
    new DataView(lying.buffer).setUint32(0, SSH_SESSION_FRAME_MAX_BYTES + 1, false);
    const d = new SshSessionFrameDecoder();
    expect(d.push(lying)).toEqual([]);
    expect(d.failed).toBe("oversize");
    // terminal: later pushes return nothing forever
    expect(d.push(encodeSshSessionFrame({ ok: true }))).toEqual([]);
  });
  test("garbage leading bytes (login banner) fail the open, never a silent skip", () => {
    const banner = new TextEncoder().encode("Last login: Mon Oct  5 10:14:33 2026\r\n");
    // interpret the banner bytes AS a length prefix: whatever it decodes to,
    // the decoder must refuse or wait forever - a resync would be the bug.
    const d = new SshSessionFrameDecoder();
    d.push(banner.subarray(0, 4));
    if (d.failed === null) {
      // not yet oversized: feed the rest; either an oversize or a
      // malformed-json verdict must land, and the frame after must not parse
      d.push(banner.subarray(4));
      d.push(encodeSshSessionFrame({ hello: true }));
    }
    expect(d.failed).not.toBeNull();
  });
  test("oversized real frame refuses at the encode, and a valid max frame passes", () => {
    expect(() => encodeSshSessionFrame({ big: "x".repeat(SSH_SESSION_FRAME_MAX_BYTES) })).toThrow();
    const fit = { big: "y".repeat(120_000) };
    const bytes = encodeSshSessionFrame(fit);
    const d = new SshSessionFrameDecoder();
    expect(d.push(bytes)).toEqual([fit]);
  });
  test("isSshSessionRef matches the node-path id grammar", () => {
    expect(isSshSessionRef(ref)).toBe(true);
    expect(isSshSessionRef("x".repeat(65))).toBe(false);
    expect(isSshSessionRef("nope!")).toBe(false);
  });
});

describe("parseSshRuntimeReportRows (the census grammar)", () => {
  test("the close RESULT payload and the subshells_report EVENT arm share one shape", () => {
    const rows = [{ subshellId: ref, alive: true, exitCode: null }];
    expect(parseSshRuntimeReportRows(rows)).toEqual(rows);
    expect(parseSshRuntimeReportRows([])).toEqual([]); // an empty census is an honest "no panes"
    // The same rows arriving inside the event frame parse identically (one
    // grammar, checked twice by the two callers that receive it).
    const ev = parseSshRuntimeEventFrame({ type: "subshells_report", subshells: rows });
    expect(ev && ev.type === "subshells_report" ? ev.subshells : null).toEqual(rows);
  });
  test("non-array payloads and bad rows refuse", () => {
    expect(parseSshRuntimeReportRows(null)).toBeNull();
    expect(parseSshRuntimeReportRows({ subshells: [] })).toBeNull();
    expect(parseSshRuntimeReportRows([{ subshellId: ref }])).toBeNull(); // no alive
    expect(parseSshRuntimeReportRows([{ subshellId: ref, alive: 1, exitCode: null }])).toBeNull(); // alive is a bool
    expect(parseSshRuntimeReportRows([{ subshellId: ref, alive: false, exitCode: "0" }])).toBeNull(); // code is an int
    expect(parseSshRuntimeReportRows([{ subshellId: ref, alive: false, exitCode: 3 }])).toEqual([
      { subshellId: ref, alive: false, exitCode: 3 },
    ]);
  });
});
