import { describe, expect, it } from "bun:test";
import { isPresetOffered } from "@/lib/preset-visibility";
import type { PresetView } from "@/types/preset";

function preset(over: Partial<PresetView> = {}): PresetView {
  return {
    id: "p",
    userId: "u",
    harnessId: "claude-code",
    name: "P",
    description: null,
    restartOnExit: 0,
    // The real row always carries the enable switch (spec 2026-10-24); the
    // launch chips offer only enabled rows.
    enabled: 1,
    ...over,
  };
}

describe("isPresetOffered", () => {
  it("offers enabled presets", () => {
    expect(isPresetOffered(preset({ enabled: 1 }))).toBe(true);
  });

  it("drops disabled presets, whatever else the row says", () => {
    // The switch is the whole story, and the New screen builds its chips by
    // filtering on this predicate, so an `enabled: 0` row never reaches them
    // (spec 2026-10-24; the web pickers apply the same rule).
    expect(isPresetOffered(preset({ enabled: 0 }))).toBe(false);
    expect(isPresetOffered(preset({ id: "p-off", name: "Parked", enabled: 0 }))).toBe(false);
  });

  it("drops only the disabled rows from a mixed list", () => {
    const rows = [preset({ id: "on" }), preset({ id: "off", enabled: 0 }), preset({ id: "on2" })];
    expect(rows.filter(isPresetOffered).map((p) => p.id)).toEqual(["on", "on2"]);
  });

  it("offers rows from an older server that never sends the field", () => {
    // The plugin-visibility precedent in miniature: an older plane knows
    // nothing about the switch and sends no `enabled`, and those rows stay
    // offered exactly as before. The type requires the field because every
    // CURRENT server sends it, so the fixture drops it on purpose.
    const { enabled: _dropped, ...olderServer } = preset({ id: "legacy" });
    expect(isPresetOffered(olderServer as PresetView)).toBe(true);
  });
});
