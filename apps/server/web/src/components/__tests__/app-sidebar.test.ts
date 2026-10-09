import { describe, expect, it } from "bun:test";
import { Fingerprint, ServerCog, Settings, SlidersHorizontal } from "lucide-react";
import { isNavGroup, visibleNavEntries, visibleNavItems } from "@/components/sidebar/sidebar-nav";

describe("sidebar nav icons (spec 2026-09-02 §3, 2026-09-11 §3.1)", () => {
  const entries = visibleNavEntries(true);
  const items = visibleNavItems(true);

  it("Presets uses SlidersHorizontal, not the Server gear", () => {
    expect(items.find((i) => i.to === "/presets")?.icon).toBe(SlidersHorizontal);
  });

  it("General keeps the plain Settings gear", () => {
    // The gear stayed on the page it always named; the GROUP above it takes
    // ServerCog, so the two never have to share (and Server stays on Nodes).
    expect(items.find((i) => i.to === "/settings")?.icon).toBe(Settings);
  });

  it("the Server Settings group takes ServerCog", () => {
    expect(entries.filter(isNavGroup).find((g) => g.id === "server-settings")?.icon).toBe(ServerCog);
  });

  it("SSH launches with subshells rather than a separate navigation page", () => {
    expect(items.some((i) => i.to === "/connect")).toBe(false);
  });

  it("SSH takes Fingerprint, in the personal Settings group (its ledger is per-owner)", () => {
    // /settings/ssh rides the member's own group, not Server Settings: the
    // grants ledger is the caller's (spec 2026-10-08 §8), and a non-admin
    // must reach it. The path under /settings/ is deliberate; General lights
    // exact-match only, so the two groups cannot both claim the page.
    expect(items.find((i) => i.to === "/settings/ssh")?.icon).toBe(Fingerprint);
    const personal = entries.filter(isNavGroup).find((g) => g.id === "personal-settings");
    expect(personal?.children.some((c) => c.to === "/settings/ssh")).toBe(true);
    // And it is visible to a member: the WHOLE personal group is ungated.
    expect(visibleNavItems(false).some((i) => i.to === "/settings/ssh")).toBe(true);
  });

  it("no two visible icons are the same — group headers included", () => {
    // Icons are how the collapsed rail names a page, so a duplicate there is
    // two rows that read as one. The group's own icon counts: it sits in the
    // same column as every leaf above it.
    const icons = [...entries.filter(isNavGroup).map((g) => g.icon), ...items.map((i) => i.icon)];
    expect(new Set(icons).size).toBe(icons.length);
  });
});
