import { describe, expect, it } from "bun:test";
import { groupOpen, isNavGroup, visibleNavEntries, visibleNavItems } from "@/components/app-sidebar";

/**
 * The pages that live inside the admin group (spec 2026-09-11 §2.1, plus the
 * Service page of spec 2026-09-12 §4.1).
 */
const GROUP_PAGES = [
  "/settings",
  "/settings/users",
  "/settings/api-keys",
  "/settings/plugins",
  "/settings/service",
  "/settings/updates",
  "/settings/status",
  "/settings/audit",
];

/**
 * The admin nav gate (spec 2026-09-02 settings-split §4, regrouped by
 * 2026-09-11 §3.2): the Server Settings group shows for admins only, and
 * UNKNOWN (loading) is hidden — the "unknown ≠ open" posture the registration
 * switch set. Everything above it is unconditional.
 */
describe("visibleNavItems", () => {
  it("hides every page in the group while the flag is false or unknown", () => {
    for (const flag of [false, undefined]) {
      const paths = visibleNavItems(flag).map((i) => i.to);
      for (const page of GROUP_PAGES) expect(paths).not.toContain(page);
      expect(paths).toEqual(["/", "/workspaces", "/nodes", "/presets"]);
    }
  });

  it("gives an admin every group page, flattened in rail order", () => {
    expect(visibleNavItems(true).map((i) => i.to)).toEqual(["/", "/workspaces", "/nodes", "/presets", ...GROUP_PAGES]);
  });
});

describe("visibleNavEntries", () => {
  it("carries exactly one group, gated as a whole", () => {
    const groups = visibleNavEntries(true).filter(isNavGroup);
    expect(groups.map((g) => g.label)).toEqual(["Server Settings"]);
    expect(groups[0]?.requiresAdmin).toBe(true);
  });

  it("puts the gate on the group and nowhere else", () => {
    // The children carry no flag of their own: one gate to reason about
    // rather than seven that can disagree.
    for (const group of visibleNavEntries(true).filter(isNavGroup)) {
      for (const child of group.children) expect(child.requiresAdmin).toBeUndefined();
    }
  });

  it("drops the group whole while the flag is false or unknown", () => {
    for (const flag of [false, undefined]) expect(visibleNavEntries(flag).filter(isNavGroup)).toEqual([]);
  });
});

/**
 * The route decides, and a chevron press overrides it until the route changes
 * (spec 2026-09-11 §3.3, corrected 2026-09-12).
 *
 * The first version forced a group holding the current page open, so the
 * chevron did nothing on the pages a person is most likely to press it from —
 * reported as "I'm not able to collapse things". `undefined` is therefore the
 * ordinary state, not a missing value: it means nobody has pressed since the
 * last navigation, so the route's own answer stands.
 */
describe("groupOpen", () => {
  it("follows the route when nobody has pressed", () => {
    expect(groupOpen(undefined, true)).toBe(true);
    expect(groupOpen(undefined, false)).toBe(false);
  });

  it("lets a press shut a group you are INSIDE", () => {
    // The bug this file now pins: the old rule returned true here.
    expect(groupOpen(false, true)).toBe(false);
  });

  it("lets a press open a group you are outside", () => {
    expect(groupOpen(true, false)).toBe(true);
  });
});
