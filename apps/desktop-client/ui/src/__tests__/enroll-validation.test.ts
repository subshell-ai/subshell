/**
 * Client-side validation, which exists so a typo costs a message rather than a
 * setup key. Everything checkable is checked BEFORE the CLI is reached.
 */
import { describe, expect, it } from "bun:test";
import { MAX_NODE_NAME_LEN } from "@/lib/copy";
import { validateEnroll } from "@/lib/enroll-validation";

const GOOD_KEY = "nsk_0123456789012345678901234567890a";

const values = (overrides: Partial<Record<"server" | "key" | "name", string>> = {}) => ({
  server: "https://subshell.example.com",
  key: GOOD_KEY,
  name: "",
  ...overrides,
});

describe("the server URL", () => {
  it("accepts http and https", () => {
    expect(validateEnroll(values({ server: "http://box.local:3080" })).invalid).toBe(false);
    expect(validateEnroll(values()).invalid).toBe(false);
  });

  it("refuses a URL with no scheme", () => {
    const result = validateEnroll(values({ server: "subshell.example.com" }));
    expect(result.invalid).toBe(true);
    expect(result.errors.server).toContain("include the scheme");
  });

  it("refuses a scheme that is not http or https", () => {
    const result = validateEnroll(values({ server: "ftp://subshell.example.com" }));
    expect(result.invalid).toBe(true);
    expect(result.errors.server).toContain("http or https");
  });

  it("refuses an empty URL", () => {
    expect(validateEnroll(values({ server: "" })).errors.server).toContain("control plane's URL");
  });

  // A warning, never a block: running the control plane and a node on one box
  // is exactly what the desktop pair exists for.
  it("does NOT refuse a loopback URL", () => {
    expect(validateEnroll(values({ server: "http://localhost:3080" })).invalid).toBe(false);
    expect(validateEnroll(values({ server: "http://127.0.0.1:3080" })).errors.server).toBe("");
  });

  it("trims, and passes the trimmed original through", () => {
    expect(validateEnroll(values({ server: "  https://subshell.example.com  " })).args.server).toBe(
      "https://subshell.example.com",
    );
  });
});

describe("the setup key", () => {
  it("accepts the mint shape: nsk_ plus 32 url-safe characters", () => {
    expect(validateEnroll(values({ key: GOOD_KEY })).errors.key).toBe("");
    expect(validateEnroll(values({ key: `nsk_${"-_".repeat(16)}` })).errors.key).toBe("");
  });

  it("refuses a partial paste", () => {
    const result = validateEnroll(values({ key: "nsk_0123456789" }));
    expect(result.invalid).toBe(true);
    expect(result.errors.key).toContain("partial paste");
  });

  it("refuses a wrong prefix and the wrong alphabet", () => {
    expect(validateEnroll(values({ key: "sk_0123456789012345678901234567890a" })).invalid).toBe(true);
    expect(validateEnroll(values({ key: "nsk_0123456789012345678901234567890+" })).invalid).toBe(true);
  });

  it("refuses an empty key", () => {
    expect(validateEnroll(values({ key: "" })).errors.key).toContain("Paste the setup key");
  });

  // It is a one-time credential, and an error string is the easiest place for
  // one to end up on a screenshot.
  it("never echoes the key back in a message", () => {
    const secret = "nsk_thisisasecretthatmustnotappear";
    for (const key of [secret, `${secret}xxxxxxxx`, " nsk_short "]) {
      const result = validateEnroll(values({ key }));
      for (const message of Object.values(result.errors)) {
        expect(message).not.toContain(key.trim());
      }
    }
  });
});

describe("the node name", () => {
  it("is optional, and blank means the agent's hostname default", () => {
    const result = validateEnroll(values({ name: "   " }));
    expect(result.invalid).toBe(false);
    expect(result.args.name).toBeNull();
  });

  it("accepts a name at the limit and refuses one past it", () => {
    expect(validateEnroll(values({ name: "a".repeat(MAX_NODE_NAME_LEN) })).invalid).toBe(false);
    const over = validateEnroll(values({ name: "a".repeat(MAX_NODE_NAME_LEN + 1) }));
    expect(over.invalid).toBe(true);
    expect(over.errors.name).toContain(`${MAX_NODE_NAME_LEN + 1} characters`);
  });

  // The control plane counts characters, so a length in UTF-16 code units
  // would refuse a name the server accepts (and vice versa for astral chars).
  it("counts code points, not UTF-16 units", () => {
    expect(validateEnroll(values({ name: "🖥".repeat(MAX_NODE_NAME_LEN) })).invalid).toBe(false);
  });

  it("trims before sending", () => {
    expect(validateEnroll(values({ name: "  workstation  " })).args.name).toBe("workstation");
  });
});
