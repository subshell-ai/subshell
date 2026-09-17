import { describe, expect, it } from "bun:test";
import { isLoopbackUrl } from "@/lib/loopback";

describe("isLoopbackUrl", () => {
  it("matches every spelling of this machine", () => {
    expect(isLoopbackUrl("http://localhost:3080")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:3080")).toBe(true);
    // Not just 127.0.0.1: the whole /8 is loopback, and a server bound to one
    // of the others is reachable from nowhere else either.
    expect(isLoopbackUrl("http://127.1.2.3:3080")).toBe(true);
    // WHATWG URL keeps the brackets on an IPv6 literal, so only the bracketed
    // spelling can ever match — the bare one is not a valid URL.
    expect(isLoopbackUrl("http://[::1]:3080")).toBe(true);
    expect(isLoopbackUrl("http://LOCALHOST:3080")).toBe(true);
    // The four-octet regex is only safe because the parser canonicalizes every
    // IPv4 shorthand before it is matched — `127.1`, the 32-bit integer, hex,
    // and zero-padded octets all normalize to `127.0.0.1`. That is the claim
    // the narrowing rests on, so it is pinned here rather than in a comment: a
    // runtime that stopped doing it would make the regex under-match silently.
    expect(isLoopbackUrl("http://127.1")).toBe(true);
    expect(isLoopbackUrl("http://2130706433")).toBe(true);
    expect(isLoopbackUrl("http://0x7f.1")).toBe(true);
    expect(isLoopbackUrl("http://127.000.000.1")).toBe(true);
    expect(isLoopbackUrl("http://[0:0:0:0:0:0:0:1]")).toBe(true);
    // A single trailing dot is the DNS root; it survives the parser verbatim
    // and resolves exactly where the dotless spelling does.
    expect(isLoopbackUrl("http://localhost.")).toBe(true);
    expect(isLoopbackUrl("http://localhost.:3080")).toBe(true);
    // IPv4-mapped IPv6 — the parser rewrites it to hex before we see it, so
    // `[::ffff:127.0.0.1]` arrives as `[::ffff:7f00:1]`.
    expect(isLoopbackUrl("http://[::ffff:127.0.0.1]")).toBe(true);
    expect(isLoopbackUrl("http://[::ffff:7f00:1]")).toBe(true);
  });

  it("does not match a routable address, and never throws on junk", () => {
    expect(isLoopbackUrl("https://plane.tail1234.ts.net")).toBe(false);
    expect(isLoopbackUrl("http://192.168.1.14:3080")).toBe(false);
    // 127.0.0.1.example.com is somebody else's host; a prefix match on the
    // whole string rather than the hostname would hand it a pass.
    expect(isLoopbackUrl("http://127.0.0.1.example.com")).toBe(false);
    // A trailing dot is stripped, not ignored: `127.0.0.1.example.com.` is
    // still somebody else's domain.
    expect(isLoopbackUrl("http://127.0.0.1.example.com.")).toBe(false);
    // Not every mapped v6 address is loopback — ::ffff:c0a8:10e is 192.168.1.14.
    expect(isLoopbackUrl("http://[::ffff:c0a8:10e]")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});
