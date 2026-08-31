import { describe, expect, it } from "bun:test";
import { cookieHeader, SECURE_SESSION_COOKIE, SESSION_COOKIE, tokenFromSetCookie } from "@/lib/cookie";

describe("cookieHeader", () => {
  it("sends BOTH spellings, because the backend's own guard accepts both", () => {
    const header = cookieHeader("tok123");
    expect(header).toBe(`${SESSION_COOKIE}=tok123; ${SECURE_SESSION_COOKIE}=tok123`);
  });

  it("omits the header entirely when signed out", () => {
    expect(cookieHeader(null)).toBeUndefined();
    expect(cookieHeader(undefined)).toBeUndefined();
    expect(cookieHeader("")).toBeUndefined();
  });
});

describe("tokenFromSetCookie", () => {
  it("reads the https-prefixed name that better-auth issues over TLS", () => {
    expect(tokenFromSetCookie([`__Secure-better-auth.session_token=abc; Path=/; HttpOnly`])).toBe("abc");
  });

  it("reads the plain name used over http", () => {
    expect(tokenFromSetCookie([`better-auth.session_token=xyz; Path=/`])).toBe("xyz");
  });

  it("preserves base64 padding in the value", () => {
    expect(tokenFromSetCookie([`better-auth.session_token=YWJjZA==; Path=/`])).toBe("YWJjZA==");
  });

  it("ignores unrelated cookies and empty responses", () => {
    expect(tokenFromSetCookie(["other=1; Path=/"])).toBeUndefined();
    expect(tokenFromSetCookie([])).toBeUndefined();
  });

  it("treats a cleared cookie as sign-out, not as a rotation", () => {
    expect(tokenFromSetCookie([`better-auth.session_token=; Max-Age=0`])).toBeUndefined();
    expect(tokenFromSetCookie([`better-auth.session_token=undefined; Path=/`])).toBeUndefined();
  });
});
