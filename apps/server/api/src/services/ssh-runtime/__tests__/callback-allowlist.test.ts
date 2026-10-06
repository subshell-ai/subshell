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

  /**
   * The C2 belt (review 2026-10-06): the caller normalizes with `new URL`
   * BEFORE matching and executes the SAME normalized value, so the raw
   * traversal strings below cannot reach the matcher through the production
   * path. They reach it DIRECTLY in tests and through a lying runtime, and
   * the matcher must still refuse them by segment, not just by the first-
   * segment id equality the old matcher could be walked around with.
   */
  test("dot segments inside the pane path are refused outright (the C2 traversal belt)", () => {
    // own id, then `../` to another pane's id: the old matcher sliced to the
    // first segment, named the OWN id, and the executor's URL normalization
    // took it to the OTHER pane's route with this pane's token.
    expect(matchCallbackPath(`/api/subshells/${OWN}/../${FOREIGN}/input`, "POST", OWN).allow).toBe(false);
    expect(matchCallbackPath(`/api/subshells/${OWN}/../${FOREIGN}/input`, "POST", OWN)).toMatchObject({
      allow: false,
    });
    // own id, then `../` out of the family entirely: `/api/users`.
    expect(matchCallbackPath(`/api/subshells/${OWN}/../../users`, "GET", OWN).allow).toBe(false);
    // single-dot and encoded spellings (the URL parser folds these before the
    // matcher sees them in production; this pins the belt anyway).
    expect(matchCallbackPath(`/api/subshells/${OWN}/./input`, "GET", OWN).allow).toBe(false);
    expect(matchCallbackPath(`/api/subshells/${OWN}/%2e%2e/users`, "GET", OWN).allow).toBe(false);
    expect(matchCallbackPath(`/api/subshells/${FOREIGN}%2f..%2f${OWN}/input`, "POST", OWN).allow).toBe(false);
    // the identities/channels families carry no id slot but obey the same rule
    expect(matchCallbackPath("/api/channels/../users", "GET", OWN).allow).toBe(false);
    expect(matchCallbackPath("/api/identities/..%2fadmin", "GET", OWN).allow).toBe(false);
  });

  test("a query on the own-pane path is uniform grammar: matched on pathname, id intact", () => {
    // (the folded Minor: the old matcher glued `?…` into the id segment, so
    // `/api/subshells/<own>?x=1` refused while `/log?from=` passed.)
    // Production matches u.pathname and passes u.search separately, so the
    // bare pathname is what hits the matcher; the query never corrupts the id.
    expect(matchCallbackPath(`/api/subshells/${OWN}`, "GET", OWN)).toEqual({ allow: true, paneId: OWN });
    expect(matchCallbackPath(`/api/subshells/${OWN}/log`, "GET", OWN)).toEqual({ allow: true, paneId: OWN });
  });
});
