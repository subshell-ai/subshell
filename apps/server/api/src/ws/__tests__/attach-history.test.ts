import { describe, expect, it } from "bun:test";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import { sendHistoryFrame } from "@/ws/attach-history.js";
import type { WsSocket } from "@/ws/viewers.js";

/**
 * The seam safety of the `history` frame. The window ends at an arbitrary
 * byte offset, so its bytes can STOP mid-marker while the live pump's first
 * bytes carry the completion: a stateless strip misses the split head and
 * xterm completes the mode ACROSS ITS OWN WRITES, parking the panel on the
 * alt buffer (`?1049`) or gating paint for a second (`?2026`) — this frame's
 * own bug, resurrected at the history→live seam. The helper strips through a
 * throwaway ModeStreamStripper and DELIBERATELY DROPS the held tail. The
 * window math and the whole-frame strip ride the real attach paths
 * (`subshell-ws-local-attach.test.ts`, `remote-subshell-ws.test.ts`); this
 * file pins the seam itself.
 */

const ALT_IN = "\x1b[?1049h";
const BSU = "\x1b[?2026h";

/** A socket collecting what the helper ships; no negotiated mode, so JSON. */
function fakeWs() {
  const frames: string[] = [];
  const ws = {
    data: {},
    send: (d: string | Uint8Array) => {
      frames.push(typeof d === "string" ? d : new TextDecoder().decode(d));
      return 0;
    },
    close: () => {},
  } as unknown as WsSocket;
  return { ws, frames };
}

/** A launcher whose log-window read always answers `bytes`. */
function launcherAnswering(bytes: string): NodeLauncher {
  return {
    readLog: async () => ({ bytes: new TextEncoder().encode(bytes), next: 0 }),
  } as unknown as NodeLauncher;
}

/** The `history` frame's data, or null when no frame was sent. */
function historyData(frames: string[]): string | null {
  for (const f of frames) {
    const frame = JSON.parse(f) as { type: string; data?: string };
    if (frame.type === "history") return frame.data ?? null;
  }
  return null;
}

describe("sendHistoryFrame — the history→live seam", () => {
  it("drops a split alt-screen head at the window's END so the live remainder cannot complete it", async () => {
    const { ws, frames } = fakeWs();
    // The window ends `…ESC[?104` (6 of the 8 bytes of `?1049h`) and the
    // live pump delivers the completion (`9h`) as its own first write.
    await sendHistoryFrame(ws, launcherAnswering("boot junk \x1b[?104"), "pane-1", 100);
    const data = historyData(frames);
    expect(data).toBe("boot junk ");
    // The frame carries neither the split head nor a completed marker…
    expect(data).not.toContain("\x1b[?104");
    expect(data).not.toContain(ALT_IN);
    // …and neither does the PAIR xterm actually parses, history then the
    // live `9h`: with the head dropped, the remainder is literal text.
    expect(`${data}9h`).not.toContain(ALT_IN);
  });

  it("drops a split DEC 2026 head the same way (the 1 s paint gate)", async () => {
    const { ws, frames } = fakeWs();
    await sendHistoryFrame(ws, launcherAnswering("tail\x1b[?2026"), "pane-1", 100);
    const data = historyData(frames);
    expect(data).toBe("tail");
    // History then the live `h` must not re-assemble a sync-begin either.
    expect(`${data}h`).not.toContain(BSU);
  });

  it("a window that is nothing but an incomplete marker ships no frame", async () => {
    const { ws, frames } = fakeWs();
    await sendHistoryFrame(ws, launcherAnswering("\x1b[?104"), "pane-1", 100);
    // Empty after the held head is dropped; absence is legal to the client.
    expect(frames).toEqual([]);
  });

  it("still strips whole markers inside the window and passes unrelated modes intact", async () => {
    const { ws, frames } = fakeWs();
    // The stateful route subsumes the stateless one (a whole `?1049h` mid-
    // window vanishes), and a complete trailing cursor-hide is no marker's
    // prefix, so nothing is held back at the end and it ships untouched.
    await sendHistoryFrame(ws, launcherAnswering(`${ALT_IN}body\x1b[?25l`), "pane-1", 100);
    expect(historyData(frames)).toBe("body\x1b[?25l");
  });
});
