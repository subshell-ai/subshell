import { describe, expect, it } from "bun:test";
import type { ExpoPushTicket } from "expo-server-sdk";
import {
  badgeCount,
  buildExpoMessages,
  chunk,
  isUnregisteredTicket,
  looksLikeExpoToken,
} from "@/services/expo-push.js";

describe("badgeCount", () => {
  it("adds 1 only for the watcher-order race (event will stamp, row not stamped yet)", () => {
    // recordAttention stamps BEFORE notifying: the row already carries the stamp.
    expect(badgeCount(2, "turn_complete", "2026-08-31T00:00:00.000Z")).toBe(2);
    // notify-idle notifies BEFORE stamping: this row is not in `waiting` yet.
    expect(badgeCount(2, "turn_complete", null)).toBe(3);
    expect(badgeCount(2, "needs_attention", null)).toBe(3);
    // non-waiting kinds never bump.
    expect(badgeCount(2, "exited", null)).toBe(2);
    expect(badgeCount(2, "crashed", null)).toBe(2);
    expect(badgeCount(2, "crashed_final", "2026-08-31T00:00:00.000Z")).toBe(2);
    expect(badgeCount(0, "turn_complete", null)).toBe(1);
  });
});

describe("buildExpoMessages", () => {
  it("names the registered category/channel so lock-screen actions actually appear", () => {
    // The app registers category "subshell" (Open/Silence) and android channel
    // "subshell-subshells" (src/native/push.ts). A remote notification only surfaces
    // them when the payload names them — APNs `category`, Android `channel_id`
    // (expo maps `_channelId`). Without these the headline lock-screen Silence
    // action is inert on real devices.
    const [m] = buildExpoMessages(["ExponentPushToken[a]"], "sess-1", "needs_attention", 0);
    expect(m.categoryId).toBe("subshell");
    expect(m.channelId).toBe("subshell-subshells");
    expect(m._channelId).toBe("subshell-subshells"); // legacy twin, always the same value
  });

  it("builds one opaque message per token — never a name, path or operator text", () => {
    const msgs = buildExpoMessages(["ExponentPushToken[a]", "ExponentPushToken[b"], "sess-1", "needs_attention", 4);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({
      to: "ExponentPushToken[a]",
      title: "subshell",
      body: "A subshell needs you",
      badge: 4,
      sound: "default",
      threadId: "sess-1",
      tag: "sess-1", // Android: same tag replaces the subshell's earlier push (web `tag` parity)
      collapseId: "sess-1", // iOS: apns-collapse-id, same replace semantics
      categoryId: "subshell",
      channelId: "subshell-subshells",
      _channelId: "subshell-subshells",
      data: { sid: "sess-1", kind: "needs_attention", origin: expect.any(String) },
    });
    // The privacy invariant (spec §Push): only token/copy/count/uuid cross the relay.
    const wire = JSON.stringify(msgs);
    expect(wire).not.toContain("resume-verify");
    expect(wire).not.toContain("/home/");
    for (const kind of ["turn_complete", "needs_attention", "exited", "crashed", "crashed_final"] as const) {
      const [m] = buildExpoMessages(["t"], "s", kind, 0);
      expect(m?.body.length).toBeGreaterThan(0);
      expect(m?.title).toBe("subshell"); // constant title, never the subshell name
    }
  });
});

describe("looksLikeExpoToken", () => {
  it("accepts the real shape and rejects junk rows", () => {
    expect(looksLikeExpoToken("ExponentPushToken[DnX1q2-abc_DEF987]")).toBe(true);
    expect(looksLikeExpoToken("https://push.example/x")).toBe(false);
    expect(looksLikeExpoToken("ExponentPushToken[]")).toBe(false);
    expect(looksLikeExpoToken("")).toBe(false);
  });
});

describe("isUnregisteredTicket", () => {
  it("flags ONLY DeviceNotRegistered as a prune signal", () => {
    const err = (error: string): ExpoPushTicket =>
      ({ status: "error", message: "boom", details: { error } }) as unknown as ExpoPushTicket;
    expect(isUnregisteredTicket(err("DeviceNotRegistered"))).toBe(true);
    expect(isUnregisteredTicket(err("MessageTooBig"))).toBe(false); // our bug → keep the row
    expect(isUnregisteredTicket({ status: "ok", id: "t" } as ExpoPushTicket)).toBe(false);
    expect(isUnregisteredTicket({ status: "error", message: "no details" } as unknown as ExpoPushTicket)).toBe(false);
  });
});

describe("chunk", () => {
  it("splits at 100 by default and keeps order", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const parts = chunk(items);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(parts.flat()).toEqual(items);
    expect(chunk([])).toEqual([]);
    expect(chunk([1, 2], 1)).toEqual([[1], [2]]);
  });
});
