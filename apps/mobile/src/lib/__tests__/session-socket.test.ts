import { describe, expect, it } from "bun:test";
import { RECONNECT_DELAY_MS, shouldReconnectAfterClose } from "@/lib/session-socket";

describe("close-code policy (mirrors use-session-ws.ts:63-64,128)", () => {
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
