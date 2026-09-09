import { describe, expect, it } from "bun:test";
import { visibleNavItems } from "@/components/app-sidebar";

/**
 * The admin nav gate (spec 2026-09-02 settings-split §4): "Instance" shows for
 * admins only, and UNKNOWN (loading) is hidden — the "unknown ≠ open" posture
 * the registration switch set. Everything else is unconditional.
 */
describe("visibleNavItems", () => {
  it("hides the Server entry while the flag is false or unknown", () => {
    for (const flag of [false, undefined]) {
      const items = visibleNavItems(flag);
      expect(items.some((i) => i.to === "/settings")).toBe(false);
      expect(items.some((i) => i.to === "/users")).toBe(true);
    }
  });
  it("shows the Server entry for admins, labeled Server", () => {
    const items = visibleNavItems(true);
    expect(items.find((i) => i.to === "/settings")?.label).toBe("Instance");
  });
});
