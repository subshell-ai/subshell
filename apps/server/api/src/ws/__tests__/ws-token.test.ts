import { afterEach, describe, expect, it } from "bun:test";
import {
  clearWsTokensForTests,
  consumeWsToken,
  dropUserTokensFor,
  issueWsToken,
  MAX_PENDING_WS_TOKENS,
  setWsTokenCapForTests,
  WsTokenCapacityError,
} from "@/ws/ws-token.js";

/**
 * The ws-token store, in the two ways it can say no.
 *
 * - THE CAP (security audit 2026-09, item 8): #159 made mints machine-
 *   reachable at script rates against what was an unbounded in-memory Map
 *   whose only trim was a timer nobody's writes bounded. The cap is the
 *   store's own limit, checked at ISSUE: sweep expired first, then refuse
 *   rather than grow. A refusal burns no token slot, so the next mint after
 *   one fails the same as after any ordinary issue.
 * - THE DISABLE SWEEP ({@link dropUserTokensFor}): redemption consults the
 *   store ALONE, never the account, so a token minted inside its 30-second
 *   life moments before an account disable would, after the disable's socket
 *   sweeps, re-create exactly the attach the disable existed to end. Dropping
 *   the user's entries makes its redemption fail like any unknown token's —
 *   the same refusal SHAPE, so a dropped token cannot even be told apart
 *   from a bad one.
 */
describe("ws-token mint cap", () => {
  afterEach(() => {
    clearWsTokensForTests();
    setWsTokenCapForTests(null);
  });

  it("exports the production cap of 10 000 outstanding tokens", () => {
    expect(MAX_PENDING_WS_TOKENS).toBe(10_000);
  });

  it("refuses at the cap with the named error rather than growing the store", () => {
    const previous = setWsTokenCapForTests(3);
    try {
      issueWsToken("u1");
      issueWsToken("u1");
      issueWsToken("u1");
      expect(() => issueWsToken("u1")).toThrow(WsTokenCapacityError);
      // The refusal is the 503 the mint route surfaces, carried the same way
      // every other status-bearing error class in this codebase carries it.
      try {
        issueWsToken("u1");
      } catch (err) {
        expect((err as { status?: number }).status).toBe(503);
        expect((err as Error).message).toContain("too many outstanding attach tokens");
      }
    } finally {
      setWsTokenCapForTests(previous);
    }
  });

  it("a consume frees room, and a refusal burns none", () => {
    setWsTokenCapForTests(2);
    const first = issueWsToken("u1");
    issueWsToken("u1");
    expect(() => issueWsToken("u1")).toThrow(WsTokenCapacityError);
    // Consuming one outstanding token makes exactly one slot.
    expect(consumeWsToken(first)).not.toBeNull();
    const third = issueWsToken("u1");
    expect(third.length > 0).toBe(true);
    expect(() => issueWsToken("u1")).toThrow(WsTokenCapacityError);
  });

  it("expired tokens are swept at issue, so a full house of dead tokens still mints", () => {
    setWsTokenCapForTests(2);
    issueWsToken("u1");
    issueWsToken("u1");
    // Past the 30 s TTL without anyone consuming: the sweep at the capped
    // issue is what tells "all slots live" from "the store is full of corpses".
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    try {
      expect(() => issueWsToken("u1")).not.toThrow();
    } finally {
      Date.now = realNow;
    }
  });

  it("consume and bind semantics are untouched by the cap", () => {
    const token = issueWsToken("u1", "s_9");
    expect(consumeWsToken(token)).toEqual({ userId: "u1", subshellId: "s_9" });
    // Single-use is still true: a second redemption reads null.
    expect(consumeWsToken(token)).toBeNull();
  });
});

describe("ws-token user drop (a disable revokes pre-minted attaches)", () => {
  afterEach(() => clearWsTokensForTests());

  it("a dropped token redeems as null — the same refusal an unknown token gets", () => {
    const token = issueWsToken("u1");
    expect(dropUserTokensFor("u1")).toBe(1);
    expect(consumeWsToken(token)).toBeNull();
    expect(consumeWsToken("never-issued")).toBeNull();
  });

  it("counts only the LIVE tokens it removed, and expired ones go with them", () => {
    const stale1 = issueWsToken("u1");
    issueWsToken("u1");
    // Past the 30 s TTL: the two entries above are corpses by the time the
    // drop walks. A token issued UNDER the advanced clock is live relative to
    // it (+61 s out), so the drop sees exactly one live revocation and three
    // removed entries — the corpses were already refusing redemption on their
    // own, and counting them would inflate the audit line.
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    const live = issueWsToken("u1");
    try {
      expect(dropUserTokensFor("u1")).toBe(1);
    } finally {
      Date.now = realNow;
    }
    expect(consumeWsToken(stale1)).toBeNull();
    expect(consumeWsToken(live)).toBeNull();
  });

  it("leaves every other user's outstanding tokens redeemable", () => {
    const mine = issueWsToken("u1");
    const theirs = issueWsToken("u2");
    expect(dropUserTokensFor("u1")).toBe(1);
    expect(consumeWsToken(mine)).toBeNull();
    expect(consumeWsToken(theirs)).toEqual({ userId: "u2", subshellId: null });
  });

  it("drops the SCOPED tokens too — they name the pane's owner, which is who is being disabled", () => {
    // A Bearer-key mint records the SUBSHELL'S OWNER as the identity
    // (ws-token.ts), so a system-key attach bound to the target's own pane
    // carries their userId and dies with the account. One bound to someone
    // else's pane names a different owner and is not this disable's business.
    const scoped = issueWsToken("u1", "s-mine");
    const foreign = issueWsToken("u2", "s-theirs");
    expect(dropUserTokensFor("u1")).toBe(1);
    expect(consumeWsToken(scoped)).toBeNull();
    expect(consumeWsToken(foreign)).toEqual({ userId: "u2", subshellId: "s-theirs" });
  });

  it("is a no-op for a user with nothing outstanding", () => {
    expect(dropUserTokensFor("nobody")).toBe(0);
  });
});
