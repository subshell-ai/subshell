import { describe, expect, test } from "bun:test";
import { refuseRequest } from "../guards.js";

/**
 * The three refusals of the loopback guard, each pinned as the hole it closes
 * rather than as a status code: a guard that only "returns 403" is one
 * refactor away from accepting the request it exists to refuse.
 */

const LOOPBACK = "127.0.0.1:3090";

describe("Host guard", () => {
  test("loopback names pass on any port", () => {
    for (const host of ["127.0.0.1:3090", "localhost:3090", "localhost", "[::1]:3090"]) {
      expect(refuseRequest({ method: "GET", hostHeader: host, originHeader: null, contentType: null })).toBeNull();
    }
  });

  test("a foreign Host is refused — the DNS-rebinding case", () => {
    // The victim's browser resolves evil.example.com to 127.0.0.1 and sends
    // THIS socket a Host the interface can tell nothing about. The header is
    // the only witness, so the header is what answers.
    const r = refuseRequest({
      method: "GET",
      hostHeader: "evil.example.com",
      originHeader: null,
      contentType: null,
    });
    expect(r?.status).toBe(403);
  });

  test("a missing Host is refused", () => {
    // HTTP/1.0 clients and hand-rolled sockets may omit it; a guard that
    // treats "absent" as "loopback" would be a guard with a hole in its
    // front door.
    expect(refuseRequest({ method: "GET", hostHeader: null, originHeader: null, contentType: null })?.status).toBe(403);
  });
});

describe("Origin guard", () => {
  test("an absent Origin passes (curl, a non-browser client)", () => {
    expect(refuseRequest({ method: "GET", hostHeader: LOOPBACK, originHeader: null, contentType: null })).toBeNull();
  });

  test("a foreign Origin is refused", () => {
    const r = refuseRequest({
      method: "GET",
      hostHeader: LOOPBACK,
      originHeader: "https://evil.example.com",
      contentType: null,
    });
    expect(r?.status).toBe(403);
  });

  test("a loopback Origin passes — the dashboard's own page", () => {
    expect(
      refuseRequest({
        method: "GET",
        hostHeader: LOOPBACK,
        originHeader: "http://localhost:3090",
        contentType: "application/json",
      }),
    ).toBeNull();
  });
});

describe("content-type guard on mutations", () => {
  test("a form-shaped POST is refused — the preflight-forcing rule", () => {
    // text/plain and url-encoded are the "simple request" spellings a
    // cross-origin form sends with NO preflight at all; refusing them is what
    // makes the Origin guard above reachable by a browser.
    for (const ct of ["application/x-www-form-urlencoded", "text/plain", null]) {
      expect(refuseRequest({ method: "POST", hostHeader: LOOPBACK, originHeader: null, contentType: ct })?.status).toBe(
        403,
      );
    }
  });

  test("JSON mutations pass; GETs need no content type", () => {
    expect(
      refuseRequest({
        method: "PUT",
        hostHeader: LOOPBACK,
        originHeader: "http://127.0.0.1:3090",
        contentType: "application/json",
      }),
    ).toBeNull();
    expect(refuseRequest({ method: "GET", hostHeader: LOOPBACK, originHeader: null, contentType: null })).toBeNull();
  });
});
