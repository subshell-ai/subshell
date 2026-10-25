import { describe, expect, it } from "bun:test";
import type { PreviewStreamFrame } from "@internal/subshell-protocol";
import { publishPreviewFrame, subscribePreview } from "@/lib/preview-bus";

/**
 * The pane-keyed screencast bus: the feed's socket is one per tab and frames
 * carry only the pane id, so the viewer subscribes by pane and the feed
 * publishes by frame. Unsubscribing must stop delivery - a closed viewer that
 * still receives frames is a memory leak with a JPEG problem on top.
 */

function frame(id: string, seq: number): PreviewStreamFrame {
  return { type: "preview-stream", id, seq, w: 1, h: 1, blob: "x" };
}

describe("subscribePreview / publishPreviewFrame", () => {
  it("drops oversized canvas dimensions and encoded frames before reaching a viewer", () => {
    let seen = 0;
    const off = subscribePreview("bounded", () => seen++);
    publishPreviewFrame({ ...frame("bounded", 1), w: 65535, h: 65535 });
    publishPreviewFrame({ ...frame("bounded", 2), blob: "A".repeat(400_000) });
    expect(seen).toBe(0);
    off();
  });
  it("delivers only frames for the subscribed pane", () => {
    const seen: number[] = [];
    const off = subscribePreview("a", (f) => seen.push(f.seq));
    publishPreviewFrame(frame("b", 1));
    publishPreviewFrame(frame("a", 2));
    expect(seen).toEqual([2]);
    off();
  });

  it("unsubscribe stops delivery, and the last unsubscribe forgets the pane", () => {
    let count = 0;
    const offA = subscribePreview("a", () => count++);
    const offB = subscribePreview("a", () => count++);
    publishPreviewFrame(frame("a", 1));
    expect(count).toBe(2);
    offA();
    publishPreviewFrame(frame("a", 2));
    expect(count).toBe(3);
    offB();
    publishPreviewFrame(frame("a", 3));
    expect(count).toBe(3);
  });

  it("a throwing subscriber cannot starve the others", () => {
    let delivered = 0;
    const offBad = subscribePreview("a", () => {
      throw new Error("viewer exploded");
    });
    const offGood = subscribePreview("a", () => delivered++);
    expect(() => publishPreviewFrame(frame("a", 1))).not.toThrow();
    expect(delivered).toBe(1);
    offBad();
    offGood();
  });
});
