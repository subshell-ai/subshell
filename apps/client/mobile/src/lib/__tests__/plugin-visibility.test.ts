import { describe, expect, it } from "bun:test";
import { isLaunchVisible } from "@/lib/plugin-visibility";
import type { PluginView } from "@/types/plugin";

function plugin(over: Partial<PluginView> = {}): PluginView {
  return { id: "x", name: "X", description: "", installed: true, enabled: true, ...over };
}

describe("isLaunchVisible", () => {
  it("keeps ordinary plugins", () => {
    expect(isLaunchVisible(plugin({ id: "claude-code", type: "agent-harness" }))).toBe(true);
    expect(isLaunchVisible(plugin({ id: "terminal", type: "terminal" }))).toBe(true);
  });

  it("drops networks, which drive no pane", () => {
    expect(isLaunchVisible(plugin({ id: "tailscale", type: "network" }))).toBe(false);
  });

  it("drops what declares itself unpickable, whatever its id", () => {
    // The contract is the flag, not the name: a plugin with any id that
    // says `pickable: false` is out, and the web mirror proves the same
    // rule reads the row, never an id list.
    expect(isLaunchVisible(plugin({ id: "ssh", name: "SSH", type: "terminal", pickable: false }))).toBe(false);
    expect(isLaunchVisible(plugin({ id: "tardis", type: "terminal", pickable: false }))).toBe(false);
    // An older server that never heard of the field sends no `pickable`,
    // and those rows are offered exactly as before.
    expect(isLaunchVisible(plugin({ id: "ssh", name: "SSH", type: "terminal" }))).toBe(true);
  });
});
