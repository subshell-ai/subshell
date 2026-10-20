import { describe, expect, it } from "bun:test";
import { ServerCog, Settings, SlidersHorizontal } from "lucide-react";
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

  it("SSH presets replace the personal SSH settings page", () => {
    expect(visibleNavItems(false).some((i) => i.to === "/settings/ssh")).toBe(false);
    expect(visibleNavItems(false).some((i) => i.to === "/presets")).toBe(true);
  });

  it("no two visible icons are the same — group headers included", () => {
    // Icons name the context-nav rows and the section-bar buttons, so a
    // duplicate reads as one control seen twice. The group's own icon counts:
    // it sits in the same column as every leaf above it.
    const icons = [...entries.filter(isNavGroup).map((g) => g.icon), ...items.map((i) => i.icon)];
    expect(new Set(icons).size).toBe(icons.length);
  });
});
