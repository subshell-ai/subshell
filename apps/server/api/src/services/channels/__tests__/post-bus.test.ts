import { describe, expect, it } from "bun:test";
import { notifyPosts, subscribe } from "@/services/channels/post-bus.js";

/**
 * The post bus is the in-process wake-up path: a long-poll read subscribes,
 * an appending writer notifies, and unsubscribing must be leak-free.
 */
describe("post-bus", () => {
  it("notifies subscribers of the same channel only", () => {
    let hitA = 0;
    let hitB = 0;
    const unA = subscribe("ch-a", () => hitA++);
    const unB = subscribe("ch-b", () => hitB++);
    notifyPosts("ch-a");
    notifyPosts("ch-a");
    expect([hitA, hitB]).toEqual([2, 0]);
    unA();
    unB();
    notifyPosts("ch-a");
    expect(hitA).toBe(2); // no callbacks after unsubscribe
  });
});
