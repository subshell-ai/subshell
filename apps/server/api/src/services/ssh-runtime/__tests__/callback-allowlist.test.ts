/**
 * The pane's own-token callback gate, tested as the pure function it is
 * (design 2026-10-05 §5): every refusal is a decision, never a downstream
 * 404. The negative the e2e cannot cheaply prove (a frame naming a FOREIGN
 * pane) is proven here.
 */
import { describe, expect, test } from "bun:test";
import { matchCallbackPath } from "../callback-allowlist.js";

const OWN = "0f4c1a7e-9b62-4a11-8d3e-5c2b1a0f9e8d";
const FOREIGN = "1e5d2b8f-0a73-5c22-9e41-6d3c2b1a0f7c";

describe("matchCallbackPath", () => {
  test("GET and POST on the pane's own routes are allowed and carry the server-side id", () => {
    expect(matchCallbackPath(`/api/subshells/${OWN}/input`, "GET", OWN)).toEqual({ allow: true, paneId: OWN });
    expect(matchCallbackPath(`/api/subshells/${OWN}/input`, "POST", OWN)).toEqual({ allow: true, paneId: OWN });
    expect(matchCallbackPath(`/api/subshells/${OWN}`, "GET", OWN)).toEqual({ allow: true, paneId: OWN });
    expect(matchCallbackPath(`/api/subshells/${OWN}/log`, "GET", OWN)).toEqual({ allow: true, paneId: OWN });
  });
  test("the identities list is in reach (the pane may see its own principals)", () => {
    expect(matchCallbackPath("/api/identities", "GET", OWN)).toEqual({ allow: true, paneId: OWN });
    expect(matchCallbackPath("/api/identities/x", "GET", OWN).allow).toBe(true);
  });
  test("every other verb is refused by name", () => {
    for (const verb of ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const d = matchCallbackPath(`/api/subshells/${OWN}/input`, verb, OWN);
      expect(d.allow).toBe(false);
    }
  });
  test("a frame naming another pane is refused even though the token could not call it anyway", () => {
    const d = matchCallbackPath(`/api/subshells/${FOREIGN}/input`, "POST", OWN);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("other than this session");
  });
  test("admin and machine surfaces are out of reach", () => {
    for (const p of ["/api/users", "/api/nodes", "/api/admin/status", "/api/settings", "/api/audit"]) {
      expect(matchCallbackPath(p, "GET", OWN).allow).toBe(false);
    }
  });
  test("prefix-shaped fakes do not slip through", () => {
    // id-like garbage, missing id, and a path that merely STARTS like a pane
    expect(matchCallbackPath("/api/subshells/", "GET", OWN).allow).toBe(false);
    expect(matchCallbackPath("/api/subshells/", "POST", OWN).allow).toBe(false);
    expect(matchCallbackPath(`/api/subshells/${OWN}-evil/input`, "POST", OWN).allow).toBe(false);
    expect(matchCallbackPath("/api/subshells/../users", "GET", OWN).allow).toBe(false);
    expect(matchCallbackPath("/api/subshells/NOT-A-UUID/input", "POST", OWN).allow).toBe(false);
  });
});
