import { describe, expect, it } from "bun:test";
import { InvalidInstanceUrl, looksPrivate, normalizeInstanceOrigin, wsOrigin } from "@/lib/instance-url";

describe("normalizeInstanceOrigin", () => {
  it("adds https for a public hostname typed without a scheme", () => {
    expect(normalizeInstanceOrigin("subshell.ein.disaresta.com")).toBe("https://subshell.ein.disaresta.com");
  });

  it("adds http for loopback, RFC1918 and CGNAT hosts", () => {
    expect(normalizeInstanceOrigin("localhost:3080")).toBe("http://localhost:3080");
    expect(normalizeInstanceOrigin("192.168.1.20:3080")).toBe("http://192.168.1.20:3080");
    expect(normalizeInstanceOrigin("100.71.37.94:3080")).toBe("http://100.71.37.94:3080");
  });

  it("never overrides an explicit scheme, even a downgrade", () => {
    expect(normalizeInstanceOrigin("http://subshell.ein.disaresta.com")).toBe("http://subshell.ein.disaresta.com");
  });

  it("trims whitespace and a trailing slash, keeps a path prefix", () => {
    expect(normalizeInstanceOrigin("  https://subshell.example/  ")).toBe("https://subshell.example");
    expect(normalizeInstanceOrigin("https://subshell.example/subshell/")).toBe("https://subshell.example/subshell");
  });

  it("keeps an explicit port", () => {
    expect(normalizeInstanceOrigin("https://subshell.example:8443")).toBe("https://subshell.example:8443");
  });

  it("rejects empty input, non-http schemes and embedded credentials", () => {
    expect(() => normalizeInstanceOrigin("   ")).toThrow(InvalidInstanceUrl);
    expect(() => normalizeInstanceOrigin("ftp://subshell.example")).toThrow(InvalidInstanceUrl);
    expect(() => normalizeInstanceOrigin("https://admin:hunter2@subshell.example")).toThrow(InvalidInstanceUrl);
  });
});

describe("looksPrivate", () => {
  it("treats single labels and mDNS names as private", () => {
    expect(looksPrivate("subshellbox")).toBe(true);
    expect(looksPrivate("subshell.local")).toBe(true);
  });

  it("treats a public domain as public", () => {
    expect(looksPrivate("subshell.ein.disaresta.com")).toBe(false);
  });

  it("covers the 172.16/12 bounds", () => {
    expect(looksPrivate("172.16.0.1")).toBe(true);
    expect(looksPrivate("172.31.255.255")).toBe(true);
    expect(looksPrivate("172.32.0.1")).toBe(false);
  });
  it("covers the 100.64/10 CGNAT bounds — NOT all of 100/8", () => {
    // NetBird/Tailscale hand out 100.64–127.x; anything else in 100/8 is
    // public (AWS) and must default to https, not cleartext http.
    expect(looksPrivate("100.64.0.1")).toBe(true);
    expect(looksPrivate("100.127.255.255")).toBe(true);
    expect(looksPrivate("100.71.37.94")).toBe(true); // the real NetBird host
    expect(looksPrivate("100.63.255.1")).toBe(false); // just below /10 → public
    expect(looksPrivate("100.128.0.1")).toBe(false); // just above /10 → public
    expect(looksPrivate("100.24.1.5")).toBe(false); // AWS public → https
    // …and normalizeInstanceOrigin must actually honour that (token safety).
    expect(normalizeInstanceOrigin("100.24.1.5:3080")).toBe("https://100.24.1.5:3080");
  });
});

describe("wsOrigin", () => {
  it("derives the socket scheme from the instance, never hardcoded", () => {
    expect(wsOrigin("https://subshell.example")).toBe("wss://subshell.example");
    expect(wsOrigin("http://100.71.37.94:3080")).toBe("ws://100.71.37.94:3080");
  });

  it("keeps a path prefix", () => {
    expect(wsOrigin("https://subshell.example/subshell")).toBe("wss://subshell.example/subshell");
  });
});
