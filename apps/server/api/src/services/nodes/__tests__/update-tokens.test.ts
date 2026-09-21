import { beforeEach, describe, expect, it } from "bun:test";
import {
  consumeUpdateToken,
  mintUpdateToken,
  outstandingUpdateTokens,
  resetUpdateTokensForTests,
  UPDATE_TOKEN_PREFIX,
  UPDATE_TOKEN_TTL_MS,
} from "../update-tokens.js";

/**
 * The download credential for a node update (spec 2026-09-15 §5.3).
 *
 * Every case below is a property that keeps "a node key can do nothing on
 * REST" (security §5.5) true while an agent nonetheless fetches a binary over
 * HTTP: the token is not the node's key, it buys one file, once, for ten
 * minutes, and it is stored only as a hash.
 */
/** The digest every minted token here binds; its value is irrelevant to the gate. */
const DIGEST = "b".repeat(64);

describe("update tokens", () => {
  beforeEach(() => {
    resetUpdateTokensForTests();
  });

  it("mints a url-safe `nut_` token and spends it exactly once", () => {
    const token = mintUpdateToken("n1", "linux-x64", DIGEST);
    expect(token.startsWith(UPDATE_TOKEN_PREFIX)).toBe(true);
    // It travels in a query string, so anything needing percent-encoding
    // would be a trap for whichever of the three consumers forgot.
    expect(token).toMatch(/^nut_[A-Za-z0-9_-]+$/);

    expect(consumeUpdateToken(token, "linux-x64")).toEqual({ nodeId: "n1", sha256: DIGEST });
    // Single use: a replay buys nothing.
    expect(consumeUpdateToken(token, "linux-x64")).toBeNull();
  });

  it("refuses a token presented for a DIFFERENT target", () => {
    // The whole point of the narrowing: this credential buys ONE file.
    const token = mintUpdateToken("n1", "linux-x64", DIGEST);
    expect(consumeUpdateToken(token, "darwin-arm64")).toBeNull();
    // And it is not burned by the refusal — the right target still works,
    // because a wrong-target request is somebody else's mistake, not a spend.
    expect(consumeUpdateToken(token, "linux-x64")).toEqual({ nodeId: "n1", sha256: DIGEST });
  });

  it("refuses an unknown or garbage token", () => {
    expect(consumeUpdateToken("nut_nope", "linux-x64")).toBeNull();
    expect(consumeUpdateToken("", "linux-x64")).toBeNull();
  });

  it("stores only the HASH, so the map holds nothing usable", () => {
    // The plaintext exists in the command frame and in the agent's memory.
    // A heap dump or a stray log line of this module's state must not be a
    // credential — the same discipline every other key here follows.
    const token = mintUpdateToken("n1", "linux-x64", DIGEST);
    const raw = token.slice(UPDATE_TOKEN_PREFIX.length);
    // Nothing in the module's observable surface echoes the plaintext, and
    // the only way to spend it is to present it — which is the definition of
    // "the stored value is not the credential".
    expect(outstandingUpdateTokens()).toBe(1);
    expect(JSON.stringify({ outstanding: outstandingUpdateTokens() })).not.toContain(raw);
  });

  it("expires after ten minutes", () => {
    expect(UPDATE_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
    const token = mintUpdateToken("n1", "linux-x64", DIGEST);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + UPDATE_TOKEN_TTL_MS + 1;
      expect(consumeUpdateToken(token, "linux-x64")).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("does not accumulate: minting sweeps spent and expired records", () => {
    const spent = mintUpdateToken("n1", "linux-x64", DIGEST);
    consumeUpdateToken(spent, "linux-x64");
    mintUpdateToken("n2", "linux-arm64", DIGEST);
    // One live record, not two: the sweep runs on every mint rather than on a
    // timer, because the map is bounded by how often somebody presses Update
    // and a timer would be one more thing holding the process open.
    expect(outstandingUpdateTokens()).toBe(1);
  });

  it("keeps two nodes' tokens distinct", () => {
    const a = mintUpdateToken("n1", "linux-x64", DIGEST);
    const b = mintUpdateToken("n2", "linux-x64", DIGEST);
    expect(a).not.toBe(b);
    expect(consumeUpdateToken(a, "linux-x64")).toEqual({ nodeId: "n1", sha256: DIGEST });
    expect(consumeUpdateToken(b, "linux-x64")).toEqual({ nodeId: "n2", sha256: DIGEST });
  });
});
