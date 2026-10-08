import { describe, expect, it } from "bun:test";
import type { SshSavedHost } from "@/lib/ssh";
import { buildDestinationOptions, configGroupLabel, RECENT_GROUP, SAVED_GROUP } from "../destination-options";

/**
 * The destination field's list as pure data: the fed groups and their
 * headers, the typed mirror row that makes the field accept a host no list
 * holds, and the candidate map that keeps DISPLAY (an alias label) out of the
 * WIRE (the destination token). The alias token rides only config rows -
 * §7's alias-is-display rule.
 */
const row = (over: Partial<SshSavedHost>): SshSavedHost => ({
  id: "r1",
  destination: "web01.example.com:22",
  alias: null,
  nodeId: "n1",
  savedAt: null,
  lastConnectAt: "2026-10-07T00:00:00.000Z",
  ...over,
});

describe("buildDestinationOptions", () => {
  it("groups saved, recent and config rows under their headers, in order", () => {
    const { options, candidates } = buildDestinationOptions({
      saved: [row({ id: "s1", alias: "web" })],
      recent: [row({ id: "c1", destination: "db.example.com:22", alias: null })],
      aliases: ["workbox"],
      machineName: "mac mini",
      typed: "",
    });
    expect(options.map((o) => o.group)).toEqual([SAVED_GROUP, RECENT_GROUP, configGroupLabel("mac mini")]);
    // A saved row LABELS with its alias and searches with its destination.
    expect(options[0].label).toBe("web");
    expect(options[0].searchText).toBe("web01.example.com:22");
    expect(options[2].label).toBe("workbox");
    // The wire meanings: the alias label never leaks into the destination.
    expect(candidates.get("saved:s1")).toEqual({ destination: "web01.example.com:22" });
    // Only the config row carries the alias token (the save sends it).
    expect(candidates.get("config:workbox")).toEqual({ destination: "workbox", aliasToken: "workbox" });
  });

  it("a recent row already saved reads once, under Saved", () => {
    const shared = row({ id: "d1", savedAt: "2026-10-01T00:00:00.000Z" });
    const { options } = buildDestinationOptions({
      saved: [shared],
      recent: [shared],
      aliases: [],
      machineName: null,
      typed: "",
    });
    expect(options).toHaveLength(1);
    expect(options[0].group).toBe(SAVED_GROUP);
  });

  it("typed text with no equal row becomes its own candidate, leading the list", () => {
    const { options, candidates } = buildDestinationOptions({
      saved: [row({})],
      recent: [],
      aliases: [],
      machineName: null,
      typed: "box.example",
    });
    expect(options[0]).toEqual({ value: "typed:box.example", label: "box.example" });
    expect(candidates.get("typed:box.example")).toEqual({ destination: "box.example" });
  });

  it("typed text a real row already carries gets no mirror row", () => {
    const { options } = buildDestinationOptions({
      saved: [row({ id: "s1", destination: "box.example", alias: null })],
      recent: [],
      aliases: ["box.example"],
      machineName: "mac mini",
      typed: "box.example",
    });
    expect(options.some((o) => o.value.startsWith("typed:"))).toBe(false);
    // The real rows still carry it, so the choice exists once, not twice.
    expect(options.some((o) => o.label === "box.example")).toBe(true);
  });

  it("no machine picked means no config group, and no aliases leak into it", () => {
    const { options } = buildDestinationOptions({
      saved: [],
      recent: [],
      aliases: ["workbox"],
      machineName: null,
      typed: "",
    });
    expect(options).toEqual([]);
  });
});
