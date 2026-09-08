import { describe, expect, it } from "bun:test";
import { notifyPosts } from "@/services/channels/post-bus.js";
import { waitForNewPosts } from "@/services/channels/read-wait.js";

/** Long-poll wait primitive: resolves on data, on timeout, and on abort. */
describe("waitForNewPosts", () => {
  const ctrl = () => new AbortController();

  it("returns immediately when new posts already exist", async () => {
    const t0 = Date.now();
    await waitForNewPosts({ channelId: "c", hasNew: async () => true, waitMs: 5000, signal: ctrl().signal });
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it("resolves when a notify arrives and hasNew confirms", async () => {
    let ready = false;
    const p = waitForNewPosts({ channelId: "wake-me", hasNew: async () => ready, waitMs: 5000, signal: ctrl().signal });
    setTimeout(() => {
      ready = true;
      notifyPosts("wake-me");
    }, 30);
    await p; // hangs forever if the bus wiring were broken
  });

  it("resolves on timeout with nothing new (empty-result path)", async () => {
    const t0 = Date.now();
    await waitForNewPosts({ channelId: "c2", hasNew: async () => false, waitMs: 120, signal: ctrl().signal });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  it("resolves early when the client aborts", async () => {
    const ac = ctrl();
    const p = waitForNewPosts({ channelId: "c3", hasNew: async () => false, waitMs: 5000, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await p;
  });

  it("ignores notifications for other channels", async () => {
    const t0 = Date.now();
    const p = waitForNewPosts({ channelId: "mine", hasNew: async () => false, waitMs: 150, signal: ctrl().signal });
    notifyPosts("other");
    await p;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });
});
