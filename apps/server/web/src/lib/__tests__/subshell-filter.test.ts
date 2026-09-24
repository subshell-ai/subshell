import { describe, expect, it } from "bun:test";
import type { SubshellView } from "@/types/subshell";
import { filterByNode, filterSubshells, machineIds, showMachineFilter } from "../subshell-filter";

/** A subshell with only the fields these helpers read. */
function subshell(overrides: Partial<SubshellView>): SubshellView {
  return {
    id: crypto.randomUUID(),
    presetId: "p1",
    harnessId: "claude",
    name: "subshell",
    workingDir: "/mnt/code",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    alive: true,
    activity: "active",
    ...overrides,
  } as SubshellView;
}

describe("filterSubshells", () => {
  const subshells = [
    subshell({ name: "Alpha", workingDir: "/mnt/code", harnessId: "claude" }),
    subshell({ name: "Bravo", workingDir: "/srv/api", harnessId: "codex" }),
  ];

  it("returns the input untouched for an empty or whitespace query", () => {
    expect(filterSubshells(subshells, "")).toBe(subshells);
    expect(filterSubshells(subshells, "   ")).toBe(subshells);
  });

  it("matches on name, path or harness, case-insensitively", () => {
    expect(filterSubshells(subshells, "alpha").map((s) => s.name)).toEqual(["Alpha"]);
    expect(filterSubshells(subshells, "/SRV").map((s) => s.name)).toEqual(["Bravo"]);
    expect(filterSubshells(subshells, "codex").map((s) => s.name)).toEqual(["Bravo"]);
  });

  it("returns nothing when a query matches no field", () => {
    expect(filterSubshells(subshells, "nothing-here")).toEqual([]);
  });
});

describe("machineIds / filterByNode", () => {
  const rows = [
    subshell({ name: "a", nodeId: "mac" }),
    subshell({ name: "b", nodeId: "local" }),
    subshell({ name: "c", nodeId: "mac" }),
    // No nodeId at all: an older cached row, bucketed as `local` (same rule as
    // the sidebar grouping, so the filter and the section headers never disagree).
    subshell({ name: "d" }),
  ];

  it("lists the distinct machines in discovery order, absent ids under local", () => {
    expect(machineIds(rows)).toEqual(["mac", "local"]);
  });

  it("filters to one machine, folding the id-less row into local", () => {
    expect(filterByNode(rows, "mac").map((s) => s.name)).toEqual(["a", "c"]);
    expect(filterByNode(rows, "local").map((s) => s.name)).toEqual(["b", "d"]);
  });

  it("answers empty for a machine nothing runs on", () => {
    expect(filterByNode(rows, "nowhere")).toEqual([]);
  });

  it("empty list has no machines", () => {
    expect(machineIds([])).toEqual([]);
  });
});

describe("showMachineFilter", () => {
  it("hides a filter with nothing to distinguish: no machines, or only the control-plane host", () => {
    expect(showMachineFilter([], "all")).toBe(false);
    expect(showMachineFilter(["local"], "all")).toBe(false);
  });

  it("shows once a second machine exists, or the sole machine is a real node", () => {
    expect(showMachineFilter(["local", "mac"], "all")).toBe(true);
    // A lone AGENT keeps the control: the day a second enrolls, the answer is
    // news (mirrors the launch form's hideMachineField).
    expect(showMachineFilter(["mac"], "all")).toBe(true);
  });

  it("stays visible while a machine is selected — even one that has no rows left", () => {
    // Hide it while active and the page reads "no subshells" with no control
    // to clear. A machine whose last row closed is exactly this case.
    expect(showMachineFilter(["mac"], "mac")).toBe(true);
    expect(showMachineFilter([], "mac")).toBe(true);
  });
});
