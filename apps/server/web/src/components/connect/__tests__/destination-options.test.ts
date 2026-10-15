import { describe, expect, it } from "bun:test";
import type { SshRecentDestination } from "@/lib/ssh";
import { buildDestinationOptions, configGroupLabel, RECENT_GROUP } from "../destination-options";

/**
 * The destination field's list as pure data: the fed groups and their
 * headers, the typed mirror row that makes the field accept a host no list
 * holds, and the candidate map that keeps DISPLAY (an alias label) out of the
 * WIRE (the destination token). The alias token rides only config rows -
 * §7's alias-is-display rule.
 */
const row = (over: Partial<SshRecentDestination>): SshRecentDestination => ({
  id: "r1",
  destination: "web01.example.com:22",
  alias: null,
  nodeId: "n1",
  lastConnectAt: "2026-10-07T00:00:00.000Z",
  ...over,
});

describe("buildDestinationOptions", () => {
  it("groups recent and config rows under their headers, in order", () => {
    const { options, candidates } = buildDestinationOptions({
      recent: [row({ id: "s1", alias: "web" })],
      aliases: ["workbox"],
      machineName: "mac mini",
      typed: "",
    });
    expect(options.map((o) => o.group)).toEqual([RECENT_GROUP, configGroupLabel("mac mini")]);
    // A recent row LABELS with its alias and searches with its destination.
    expect(options[0].label).toBe("web");
    expect(options[0].searchText).toBe("web01.example.com:22");
    expect(options[1].label).toBe("workbox");
    // The wire meanings: the alias label never leaks into the destination.
    expect(candidates.get("recent:s1")).toEqual({ destination: "web01.example.com:22" });
    // Only the config row carries the alias token (the save sends it).
    expect(candidates.get("config:workbox")).toEqual({ destination: "workbox", aliasToken: "workbox" });
  });

  it("typed text with no equal row becomes its own candidate, leading the list", () => {
    const { options, candidates } = buildDestinationOptions({
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
      recent: [],
      aliases: ["workbox"],
      machineName: null,
      typed: "",
    });
    expect(options).toEqual([]);
  });
});

it("displays and searches configured destinations while still launching the alias", () => {
  const { options, candidates } = buildDestinationOptions({
    recent: [],
    aliases: ["demo", "dynamic"],
    destinations: [{ alias: "demo", destination: "developer@127.0.0.1:22222" }],
    machineName: "Server",
    typed: "",
  });
  expect(options[0]?.reason).toBe("developer@127.0.0.1:22222");
  expect(options[0]?.searchText).toBe("developer@127.0.0.1:22222");
  expect(candidates.get("config:demo")?.destination).toBe("demo");
  expect(options[1]?.reason).toBe("Destination determined when connecting");
});

it("shows the concrete destination beneath recent aliases", () => {
  const destination = "developer@127.0.0.1:22222";
  const { options, candidates } = buildDestinationOptions({
    recent: [row({ id: "recent", alias: "subshell-demo", destination }), row({ id: "plain", destination })],
    aliases: [],
    machineName: "Server",
    typed: "",
  });
  expect(options[0]?.reason).toBe(destination);
  expect(options[1]?.label).toBe(destination);
  expect(options[1]?.reason).toBeUndefined();
  expect(candidates.get("recent:recent")).toEqual({ destination });
});
