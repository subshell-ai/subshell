import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { BASE64_RE } from "../guards.js";
import { base64FromBytes, base64ToBytes } from "../ssh-base64-std.js";

/**
 * The standard padded base64 codec split out of ssh-relay.ts (Task 5 review
 * M-5). The pins below are the contract the relay wire depends on: what this
 * admits must stay exactly what BASE64_RE admits (Task 4's `parseRelayFrame`
 * measures the raw length of such strings for the frame cap), and everything
 * else is refused by name, never repaired.
 */

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

describe("base64FromBytes", () => {
  it("encodes the known vectors, padded", () => {
    expect(base64FromBytes(new Uint8Array(0))).toBe("");
    expect(base64FromBytes(bytesOf("A"))).toBe("QQ==");
    expect(base64FromBytes(bytesOf("AB"))).toBe("QUI=");
    expect(base64FromBytes(bytesOf("ABC"))).toBe("QUJD");
    expect(base64FromBytes(Uint8Array.from([0x00, 0x01, 0x02]))).toBe("AAEC");
  });

  it("agrees with the platform encoder and BASE64_RE for every input length", () => {
    for (let len = 0; len <= 20; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37) & 0xff);
      const s = base64FromBytes(bytes);
      expect(s).toMatch(BASE64_RE); // the blob grammar a relay frame must satisfy
      // The same bytes through the Web-exposed encoder spell identically.
      expect(s).toBe(btoa(String.fromCharCode(...Array.from(bytes))));
    }
  });
});

describe("base64ToBytes", () => {
  it("round-trips what base64FromBytes emits", () => {
    for (let len = 0; len <= 20; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 91 + 7) & 0xff);
      expect(Array.from(base64ToBytes(base64FromBytes(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("decodes the known vectors", () => {
    expect(Array.from(base64ToBytes("QQ=="))).toEqual([0x41]);
    expect(Array.from(base64ToBytes("QUI="))).toEqual([0x41, 0x42]);
    expect(Array.from(base64ToBytes("QUJD"))).toEqual([0x41, 0x42, 0x43]);
    expect(Array.from(base64ToBytes(""))).toEqual([]);
  });

  it("refuses non-group lengths, mid-text padding, and non-canonical trailing bits", () => {
    expect(() => base64ToBytes("QQQ")).toThrow(/padded base64 group/);
    expect(() => base64ToBytes("Q=Q=")).toThrow(/non-base64 character/); // "=" is not alphabet
    expect(() => base64ToBytes("=AAA")).toThrow(/non-base64 character/);
    expect(() => base64ToBytes("AB==")).toThrow(/non-canonical trailing bits/); // 10 bits for 1 byte
  });

  it("refuses ASCII junk by name", () => {
    expect(() => base64ToBytes("A!BC")).toThrow(/non-base64 character/);
    expect(() => base64ToBytes("A BC")).toThrow(/non-base64 character/); // a space (0x20)
    expect(() => base64ToBytes("AB-_")).toThrow(/non-base64 character/); // base64URL is not standard
  });

  it("refuses a code point at or above U+0080 instead of corrupting (M-2)", () => {
    // The table spans codes 0..127 only: before the guard these read as
    // `undefined`, sailed past the `v < 0` screen, and poisoned `value` with
    // NaN. Each string below is a padded 4-char group whose body holds one
    // high code point, and each must throw.
    expect(() => base64ToBytes("Q\u00e9BC")).toThrow(/non-base64 character/); // U+00E9
    expect(() => base64ToBytes("Q\u3042BC")).toThrow(/non-base64 character/); // U+3042
    expect(() => base64ToBytes("Q\u2028BC")).toThrow(/non-base64 character/); // U+2028
  });

  it("refuses the U+0080 boundary itself inside a group", () => {
    expect(() => base64ToBytes("Q\u0080BC")).toThrow(/non-base64 character/);
  });
});

describe("ssh-base64-std.ts is Metro-safe", () => {
  it("has no node: builtin import in CODE", () => {
    // Same pin as ssh-relay.test.ts: comments carry "node:" as prose, so
    // the scanned text is the code with comments stripped.
    const source = readFileSync(new URL("../ssh-base64-std.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/import\s*\(?\s*["']node:/);
    expect(source).not.toMatch(/require\(\s*["']node:/);
    expect(source).not.toMatch(/\bBuffer\b/);
    expect(source).not.toMatch(/await\s+import\(/);
  });
});
