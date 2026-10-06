import { afterAll, describe, expect, test } from "bun:test";
import {
  encodeSshSessionFrame,
  parseSshRuntimeCommandFrame,
  SSH_RUNTIME_PROTOCOL,
  SSH_SESSION_LOG_WINDOW_BYTES,
  type SshRuntimeHelloWire,
  SshSessionFrameDecoder,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
import { RuntimeSessionLauncher } from "@/services/ssh-runtime/runtime-session-launcher.js";
import { SshRuntimeSession } from "@/services/ssh-runtime/session.js";
import { attachScriptedNode, type ScriptedNode } from "@/test-helpers/scripted-node.js";

/**
 * The C1 clamp (review 2026-10-06): the runtime's answers ride the 262 KiB
 * session codec, but `RuntimeSessionLauncher` composes its `log_read` windows
 * from the NODE LINK's sizes (LOG_TAIL_BYTES 256 KiB), whose base64 answers
 * cannot encode. The clamp lives in `#readLogSized`, so every caller
 * (tail, cursor read, window read, gap backfill) is covered at the one seam
 * that composes the frame. Pinned here at the wire: whatever the caller
 * asks, the `maxBytes` that reaches the destination never exceeds
 * {@link SSH_SESSION_LOG_WINDOW_BYTES}.
 */

const NODE_ID = "n-rlog-1";
const hello: SshRuntimeHelloWire = {
  type: "hello",
  runtimeProtocol: SSH_RUNTIME_PROTOCOL,
  agentVersion: "1.5.0",
  os: "linux",
  arch: "x64",
  capabilities: ["ssh-runtime", "callback-sock"],
  homeDir: "/home/dst",
  dataDir: "/home/dst/.local/share/subshell/runtime",
  tmuxSocket: "subshell-ssh-rlog00000",
  paneCount: 0,
};
const target: SshSessionTargetWire = { alias: "rlog", host: "127.0.0.1", port: 22, user: null, identityFile: null };

/** Every `log_read` frame the scripted destination saw: the maxBytes asked. */
const askedWindows: number[] = [];

let simRef: ScriptedNode | undefined;
let sessionRef: SshRuntimeSession | undefined;

/**
 * A live session on a scripted destination that answers every `log_read` as
 * an EMPTY read and records the window it was asked for. The clamp test
 * inspects the ASK, not the bytes.
 */
function mkSessionLive(): SshRuntimeSession {
  simRef = attachScriptedNode(NODE_ID, {
    ssh_session_send: (cmd) => {
      if (cmd.type !== "ssh_session_send") throw new Error("wrong cmd");
      for (const raw of new SshSessionFrameDecoder().push(new Uint8Array(Buffer.from(cmd.data_b64, "base64")))) {
        const frame = parseSshRuntimeCommandFrame(raw);
        if (frame === null || frame.type !== "log_read") continue;
        askedWindows.push(frame.maxBytes);
        sessionRef?.ingestBytes(
          encodeSshSessionFrame({
            type: "result",
            ref: frame.ref,
            ok: true,
            data: { bytes_b64: "", next: Math.min(frame.fromByte, 0), size: 0 },
          }),
        );
      }
      return undefined;
    },
  });
  const s = new SshRuntimeSession({
    id: "9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
    ownerId: "u1",
    connectingNodeId: NODE_ID,
    runtimeNodeId: "r-rlog",
    target,
    hello,
  });
  sessionRef = s;
  return s;
}

afterAll(() => simRef?.detach());

describe("RuntimeSessionLauncher log windows are session-sized (C1)", () => {
  test("readLogWindow asks no more than the runtime budget, whatever the caller named", async () => {
    askedWindows.length = 0;
    const launcher = new RuntimeSessionLauncher(mkSessionLive());
    await launcher.readLogWindow("0f4c1a7e-9b62-4a11-8d3e-5c2b1a0f9e8d", 4096, 512 * 1024);
    expect(askedWindows).toEqual([SSH_SESSION_LOG_WINDOW_BYTES]);
  });

  test("readLog (the tail-relay gap backfill) is clamped too", async () => {
    askedWindows.length = 0;
    const launcher = new RuntimeSessionLauncher(mkSessionLive());
    await launcher.readLog("0f4c1a7e-9b62-4a11-8d3e-5c2b1a0f9e8d", 0, 1024 * 1024);
    expect(askedWindows).toEqual([SSH_SESSION_LOG_WINDOW_BYTES]);
  });

  test("readLogTail anchors its window at the clamped budget: size probe first, then a window that fits", async () => {
    askedWindows.length = 0;
    const launcher = new RuntimeSessionLauncher(mkSessionLive());
    await launcher.readLogTail("0f4c1a7e-9b62-4a11-8d3e-5c2b1a0f9e8d");
    // First the 1-byte size probe; the tail window that follows must be the
    // budget, never the node link's LOG_TAIL_BYTES (256 KiB), whose base64
    // answer cannot encode into one session frame.
    expect(askedWindows[0]).toBe(1);
    expect(askedWindows.length).toBe(2);
    expect(askedWindows[1]).toBe(SSH_SESSION_LOG_WINDOW_BYTES);
    for (const asked of askedWindows) expect(asked).toBeLessThanOrEqual(SSH_SESSION_LOG_WINDOW_BYTES);
  });

  test("an honest small ask passes through unclamped (the clamp never grows or re-quantizes)", async () => {
    askedWindows.length = 0;
    const launcher = new RuntimeSessionLauncher(mkSessionLive());
    await launcher.readLogWindow("0f4c1a7e-9b62-4a11-8d3e-5c2b1a0f9e8d", 0, 8192);
    expect(askedWindows).toEqual([8192]);
  });
});
