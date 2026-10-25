import { describe, expect, test } from "bun:test";
import {
  createDisplay,
  ExistingProbeDisplayError,
  inspectDisplay,
  ownedDisplay,
  parseIdentifiers,
  probeName,
  type Run,
  removeDisplay,
} from "../betterdisplay-probe/betterdisplay.js";

const name = probeName("49a63924-e405-4f84-a0c0-a41fd750a134");
// Shape measured against BetterDisplay 5.1.1 on the M5, including string IDs.
const display = {
  UUID: "6B25533E-892C-434B-86ED-197E3E075691",
  deviceType: "VirtualScreen" as const,
  displayID: "6",
  name,
  tagID: "3",
};
const withoutProbe = JSON.stringify({ name: "Built-in Display", deviceType: "Display" });

describe("BetterDisplay experiment ownership", () => {
  test("accepts the installed CLI's unwrapped list and rejects malformed or excessive output", () => {
    expect(
      parseIdentifiers(`${JSON.stringify(display)},${JSON.stringify({ deviceType: "DisplayGroup" })}`),
    ).toHaveLength(2);
    expect(parseIdentifiers(` [${JSON.stringify(display)}] `)).toEqual([display]);
    expect(parseIdentifiers("\n")).toEqual([]);
    expect(() => parseIdentifiers("CLI access disabled")).toThrow();
    expect(() => parseIdentifiers("x".repeat(128 * 1024 + 1))).toThrow();
    expect(() => parseIdentifiers(JSON.stringify(Array(65).fill(display)))).toThrow();
  });

  test("refuses physical displays, ambiguous matches, malformed IDs and foreign names", async () => {
    for (const invalid of [
      { ...display, deviceType: "Display" },
      { ...display, name: "Someone else's display" },
      { ...display, UUID: "" },
      { ...display, tagID: "" },
      { ...display, tagID: "-1" },
      { ...display, tagID: "4294967296" },
      { ...display, displayID: 6 },
    ])
      expect(() => ownedDisplay(invalid, name)).toThrow();
    await expect(inspectDisplay(() => `${JSON.stringify(display)},${JSON.stringify(display)}`, name)).rejects.toThrow();
    await expect(inspectDisplay(() => "", "")).rejects.toThrow();
    expect(() => probeName("-identifiers")).toThrow();
  });

  test("checks the postcondition instead of treating exit zero as successful creation", async () => {
    const calls: string[][] = [];
    const run: Run = (args) => {
      calls.push(args);
      return args[0] === "get" ? withoutProbe : "";
    };
    await expect(createDisplay(run, name)).rejects.toThrow("didn't create");
    expect(calls.some((args) => args[0] === "create")).toBe(true);
    expect(calls.some((args) => args[0] === "discard")).toBe(false);
  });

  test("confirms absence using the full inventory; a failed name lookup isn't absence", async () => {
    const result = await inspectDisplay((args) => {
      expect(args).toEqual(["get", "-identifiers"]);
      return withoutProbe;
    }, name);
    expect(result).toBeNull();
    await expect(inspectDisplay(() => "", name)).rejects.toThrow("inventory");
    await expect(inspectDisplay(() => "{}", name)).rejects.toThrow("unrecognized");
  });

  test("refuses to mutate an existing name", async () => {
    const calls: string[][] = [];
    await expect(
      createDisplay((args) => {
        calls.push(args);
        return JSON.stringify(display);
      }, name),
    ).rejects.toThrow(ExistingProbeDisplayError);
    expect(calls.map((args) => args[0])).toEqual(["get"]);
  });

  test("removes exactly the verified resource, then confirms it disappeared", async () => {
    const calls: string[][] = [];
    await removeDisplay((args) => {
      calls.push(args);
      return calls.length === 1 ? JSON.stringify(display) : withoutProbe;
    }, display);
    expect(calls[1]).toEqual(["discard", "-type=VirtualScreen", "-tagID=3", `-name=${name}`]);
    expect(calls.map((args) => args[0])).toEqual(["get", "discard", "get"]);
  });

  test("never discards after a failed query or stale identity", async () => {
    for (const output of [
      "not JSON",
      JSON.stringify({ ...display, tagID: "4" }),
      JSON.stringify({ ...display, UUID: "7B25533E-892C-434B-86ED-197E3E075691" }),
    ]) {
      const calls: string[][] = [];
      await expect(
        removeDisplay((args) => {
          calls.push(args);
          return output;
        }, display),
      ).rejects.toThrow();
      expect(calls.map((args) => args[0])).toEqual(["get"]);
    }
    await expect(
      removeDisplay(() => {
        throw new Error("timeout");
      }, display),
    ).rejects.toThrow("timeout");
  });

  test("removal is idempotent but reports an unsuccessful discard", async () => {
    const calls: string[][] = [];
    await removeDisplay((args) => {
      calls.push(args);
      return withoutProbe;
    }, display);
    expect(calls.map((args) => args[0])).toEqual(["get"]);
    await expect(removeDisplay(() => JSON.stringify(display), display)).rejects.toThrow("still reports");
  });
});
