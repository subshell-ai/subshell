import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAndPinRecipients, PinnedKeyMismatchError, reloadPinSettingsForTests } from "../pin-store.js";

/**
 * The pin store is the anti-relay-substitution layer: first-seen peer keys
 * are pinned (TOFU), changed keys abort the post. Every test gets its own
 * tmp SUBSHELL_DATA_DIR (via the @internal reload hook — the real process reads
 * env once at module init); nothing touches the developer's subshell-mcp dir.
 */
let dir: string;
const pinsFile = () => join(dir, "peers.json");
const peer = (principalId: string, key: string) => ({ principalId, publicJwk: key });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subshell-pins-"));
  reloadPinSettingsForTests({ SUBSHELL_DATA_DIR: dir });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  reloadPinSettingsForTests({});
});

describe("mcp pin-store (TOFU peer keys)", () => {
  it("pins a first-seen principal silently and accepts the same key again", () => {
    checkAndPinRecipients([peer("sess:a", '{"crv":"P-256","x":"1","y":"1"}')]);
    // Pinned silently: file exists, mode 0600, exact string stored.
    const mode = statSync(pinsFile()).mode & 0o777;
    expect(mode).toBe(0o600);
    const raw = JSON.parse(readFileSync(pinsFile(), "utf8")) as Record<string, string>;
    expect(raw).toEqual({ "sess:a": '{"crv":"P-256","x":"1","y":"1"}' });
    // Second post with the same key: passes, no throw.
    expect(() => checkAndPinRecipients([peer("sess:a", '{"crv":"P-256","x":"1","y":"1"}')])).not.toThrow();
  });

  it("throws on a roster key change for a pinned principal, naming principal and path", () => {
    checkAndPinRecipients([peer("sess:a", "KEY-1")]);
    expect(() => checkAndPinRecipients([peer("sess:a", "KEY-2")])).toThrow(PinnedKeyMismatchError);
    let message = "";
    try {
      checkAndPinRecipients([peer("sess:a", "KEY-2")]);
    } catch (err) {
      message = (err as Error).message;
    }
    // Operator-actionable: who, what it might be, and exactly what to delete.
    expect(message).toContain("pinned key for sess:a changed");
    expect(message).toMatch(/rotation|substitution/);
    expect(message).toContain(pinsFile());
    expect(message).toContain("re-learn");
    // The bad key was NOT pinned over the good one.
    const raw = JSON.parse(readFileSync(pinsFile(), "utf8")) as Record<string, string>;
    expect(raw["sess:a"]).toBe("KEY-1");
  });

  it("pins and proceeds for an unknown-new principal alongside known ones", () => {
    checkAndPinRecipients([peer("sess:a", "A1")]);
    expect(() => checkAndPinRecipients([peer("sess:a", "A1"), peer("sess:b", "B1")])).not.toThrow();
    const raw = JSON.parse(readFileSync(pinsFile(), "utf8")) as Record<string, string>;
    expect(raw).toEqual({ "sess:a": "A1", "sess:b": "B1" });
  });

  it("SUBSHELL_CHANNEL_PIN=trust skips checks entirely and never touches the file", () => {
    // Strict first: pin A, then A-substitution would throw.
    checkAndPinRecipients([peer("sess:a", "KEY-1")]);
    expect(() => checkAndPinRecipients([peer("sess:a", "KEY-2")])).toThrow(PinnedKeyMismatchError);
    reloadPinSettingsForTests({ SUBSHELL_DATA_DIR: dir, SUBSHELL_CHANNEL_PIN: "trust" });
    // The substituted key now sails through — and nothing is read or written.
    expect(() => checkAndPinRecipients([peer("sess:z", "OTHER")])).not.toThrow();
    expect(() => checkAndPinRecipients([peer("sess:a", "KEY-2")])).not.toThrow();
    const raw = JSON.parse(readFileSync(pinsFile(), "utf8")) as Record<string, string>;
    expect(raw).toEqual({ "sess:a": "KEY-1" }); // untouched by trust mode
    // Fresh dir under trust: no pin file is created at all.
    const bare = mkdtempSync(join(tmpdir(), "subshell-pins-trust-"));
    try {
      reloadPinSettingsForTests({ SUBSHELL_DATA_DIR: bare, SUBSHELL_CHANNEL_PIN: "trust" });
      checkAndPinRecipients([peer("sess:a", "KEY-1")]);
      expect(existsSync(join(bare, "peers.json"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("corrupt peers.json fails closed and preserves the file aside", () => {
    writeFileSync(pinsFile(), "{ not json");
    expect(() => checkAndPinRecipients([peer("sess:a", "KEY-1")])).toThrow(/corrupt/i);
    // Moved aside under a .corrupt-* name with the original bytes intact —
    // never silently reset to "no pins".
    expect(existsSync(pinsFile())).toBe(false);
    const aside = readdirSync(dir).find((f) => f.startsWith("peers.json.corrupt-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(dir, aside as string), "utf8")).toBe("{ not json");
  });

  it("pin file with a non-string entry is treated as corrupt", () => {
    writeFileSync(pinsFile(), JSON.stringify({ "sess:a": 42 }));
    expect(() => checkAndPinRecipients([peer("sess:a", "KEY-1")])).toThrow(/corrupt/i);
    expect(existsSync(pinsFile())).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("peers.json.corrupt-"))).toBe(true);
  });

  it("two principals pinned independently are both enforced", () => {
    checkAndPinRecipients([peer("sess:a", "A1"), peer("sess:b", "B1")]);
    // Only B's key was swapped: the whole batch fails (fail closed, partial
    // rosters must not seal), and the error names B.
    expect(() => checkAndPinRecipients([peer("sess:a", "A1"), peer("sess:b", "B2")])).toThrow(/sess:b/);
    // A's pin is still valid on its own.
    expect(() => checkAndPinRecipients([peer("sess:a", "A1")])).not.toThrow();
    // And B stays refused until the entry is deleted (the documented escape).
    expect(() => checkAndPinRecipients([peer("sess:b", "B2")])).toThrow(PinnedKeyMismatchError);
    // Escape hatch works: drop B's entry (the documented manual edit), re-learn.
    const raw = JSON.parse(readFileSync(pinsFile(), "utf8")) as Record<string, string>;
    writeFileSync(pinsFile(), JSON.stringify({ "sess:a": raw["sess:a"] }));
    expect(() => checkAndPinRecipients([peer("sess:b", "B2")])).not.toThrow();
  });
});
