import { describe, expect, it } from "bun:test";
import { parseClientFrame } from "@internal/subshell-protocol";
import { RECONNECT_DELAY_MS, shouldReconnectAfterClose } from "@/lib/subshell-socket";

describe("close-code policy (mirrors use-subshell-ws.ts:63-64,128)", () => {
  it("retries everything below 4000 and nothing server-rejected", () => {
    expect(shouldReconnectAfterClose(1006)).toBe(true);
    expect(shouldReconnectAfterClose(3999)).toBe(true);
    expect(shouldReconnectAfterClose(1000)).toBe(true);
    expect(shouldReconnectAfterClose(4000)).toBe(false); // attach failed
    expect(shouldReconnectAfterClose(4001)).toBe(false); // unauthorized
    expect(shouldReconnectAfterClose(4004)).toBe(false); // not found / not running
    expect(shouldReconnectAfterClose(4999)).toBe(false);
  });

  it("keeps the documented fixed delay", () => {
    expect(RECONNECT_DELAY_MS).toBe(1500);
  });
});

describe("visibility frames (the shared-pane rule this app has to obey)", () => {
  it("emits exactly the frame the server parses", () => {
    // The web client and this one must speak the SAME frame or the phone
    // silently keeps constraining the pane while pocketed: `parseClientFrame`
    // is the arbiter, so assert against it rather than against a string.
    expect(parseClientFrame(JSON.stringify({ type: "visibility", hidden: true }))).toEqual({
      type: "visibility",
      hidden: true,
    });
    expect(parseClientFrame(JSON.stringify({ type: "visibility", hidden: false }))).toEqual({
      type: "visibility",
      hidden: false,
    });
  });

  it("is rejected when `hidden` is not a boolean, so a bad send cannot be silently ignored", () => {
    expect(parseClientFrame(JSON.stringify({ type: "visibility" }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: "visibility", hidden: "yes" }))).toBeNull();
  });
});
