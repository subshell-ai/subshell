import { afterEach, describe, expect, it } from "bun:test";
import { attachConnection, resetNodeRegistryForTests } from "@/modules/nodes/node-registry.js";
import { sendPreviewFrameOverNodeSocket } from "@/modules/nodes/preview-frames.js";

afterEach(resetNodeRegistryForTests);
const frame = { type: "preview_data", ref: "a".repeat(32), dir: "in", blob: "QUJD" } as const;

describe("preview transport queue", () => {
  it("refuses queued bytes without advancing encryption state", () => {
    let sealed = 0;
    let sent = 0;
    const conn = attachConnection("preview-queue", {
      getBufferedAmount: () => 1_048_576,
      send: () => {
        sent++;
      },
      close: () => {},
    });
    conn.link = {
      sealFrame: () => {
        sealed++;
        return new Uint8Array();
      },
    } as never;
    expect(() => sendPreviewFrameOverNodeSocket("preview-queue", frame)).toThrow(/buffer budget/);
    expect(sealed).toBe(0);
    expect(sent).toBe(0);
  });
  for (const throws of [false, true])
    it(`closes a link after a sealed frame ${throws ? "throws" : "is dropped"}`, () => {
      let closed = false;
      const conn = attachConnection("preview-drop", {
        send: () => {
          if (throws) throw new Error("dropped");
          return 0;
        },
        close: () => {
          closed = true;
        },
      });
      conn.link = { sealFrame: () => new Uint8Array([1]) } as never;
      expect(() => sendPreviewFrameOverNodeSocket("preview-drop", frame)).toThrow(/dropped/);
      expect(closed).toBe(true);
    });
});
