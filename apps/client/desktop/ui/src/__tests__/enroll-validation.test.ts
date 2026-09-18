/**
 * Client-side validation, which exists so a typo costs a message rather than a
 * setup key. Everything checkable is checked BEFORE the CLI is reached.
 */
import { describe, expect, it } from "bun:test";
import { NODE_NAME_MAX } from "@internal/subshell-protocol";
import { validateEnroll } from "@/lib/enroll-validation";

const GOOD_KEY = "nsk_0123456789012345678901234567890a";

/**
 * A VALID form by default, with one field per test allowed to break.
 *
 * `name` is filled because it is required now: the node names itself on the
 * machine that becomes it, and this form is one of the two doors that ask. A
 * default of `""` would make every server-URL and key case below fail on the
 * name instead of on the field it is about — the same trap the required field
 * sets for any caller of this function.
 */
const values = (overrides: Partial<Record<"server" | "key" | "name", string>> = {}) => ({
  server: "https://subshell.example.com",
  key: GOOD_KEY,
  name: "devbox",
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
    expect(result.errors.server).toContain("Include the scheme");
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
  // Required since the 2026-09-17 node-setup revamp. This field used to be
  // optional because `enroll` defaulted to the hostname; the dialog's name field
  // went the same week, so the question now lives where the answer is — and the
  // CLI refuses an unattended `enroll` with no name at all.
  it("is required, and blank is a refusal rather than a hostname", () => {
    for (const name of ["", "   ", "\t\n"]) {
      // (each is the ONLY broken field — `values()` supplies a good name)
      const result = validateEnroll(values({ name }));
      expect(result.invalid).toBe(true);
      expect(result.errors.name).toContain("Name this machine");
    }
  });

  it("sends what the control plane will store, not what was pasted", () => {
    // `normalizeNodeName` is the server's own rule, shared: control characters
    // out, runs of whitespace collapsed, ends trimmed.
    expect(validateEnroll(values({ name: "  mac\n\tmini  two  " })).args.name).toBe("mac mini two");
  });

  it("accepts a name at the limit and refuses one past it", () => {
    expect(validateEnroll(values({ name: "a".repeat(NODE_NAME_MAX) })).invalid).toBe(false);
    const over = validateEnroll(values({ name: "a".repeat(NODE_NAME_MAX + 1) }));
    expect(over.invalid).toBe(true);
    expect(over.errors.name).toContain(`${NODE_NAME_MAX + 1} characters`);
  });

  // The control plane counts characters, so a length in UTF-16 code units
  // would refuse a name the server accepts (and vice versa for astral chars).
  it("counts code points, not UTF-16 units", () => {
    expect(validateEnroll(values({ name: "🖥".repeat(NODE_NAME_MAX) })).invalid).toBe(false);
  });

  it("trims before sending", () => {
    expect(validateEnroll(values({ name: "  workstation  " })).args.name).toBe("workstation");
  });

  it("counts code points past the limit on what was TYPED, not on the truncated result", () => {
    // normalizeNodeName would silently slice a 65-character name to 64; the
    // refusal is the difference between "fix your name" and "the server renamed
    // your machine and told nobody".
    const over = validateEnroll(values({ name: "🖥".repeat(NODE_NAME_MAX + 1) }));
    expect(over.invalid).toBe(true);
    expect(over.errors.name).toContain(`${NODE_NAME_MAX + 1} characters`);
  });
});
