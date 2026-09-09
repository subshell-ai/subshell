import { describe, expect, it } from "bun:test";
import { Settings, SlidersHorizontal } from "lucide-react";
import { visibleNavItems } from "@/components/app-sidebar";

describe("sidebar nav icons (spec 2026-09-02 §3)", () => {
  const items = visibleNavItems(true);

  it("Profiles uses SlidersHorizontal, not the Server gear", () => {
    expect(items.find((i) => i.to === "/profiles")?.icon).toBe(SlidersHorizontal);
  });

  it("Server keeps the plain Settings gear", () => {
    expect(items.find((i) => i.label === "Instance")?.icon).toBe(Settings);
  });

  it("no two visible items share an icon", () => {
    const icons = items.map((i) => i.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
