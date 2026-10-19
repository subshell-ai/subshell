import { describe, expect, test } from "bun:test";
import { HarnessSubagents } from "../harness-subagents.js";

const child = { id: "child", name: "Review", status: "running" as const };

describe("harness subagents", () => {
  test("lifecycle removes completed children and restart discards old state", () => {
    const state = new HarnessSubagents();
    state.report("pane", "first", { event: "start", agents: [child] });
    expect(state.read("pane", "first", true).agents).toEqual([child]);
    state.report("pane", "first", { event: "stop", agentId: "child" });
    expect(state.read("pane", "first", true).agents).toEqual([]);
    state.report("pane", "first", { event: "start", agents: [child] });
    expect(state.read("pane", "second", true).agents).toEqual([]);
  });
  test("selection is bounded to reported children and confirmed by the harness", () => {
    const state = new HarnessSubagents();
    state.report("pane", "run", { event: "snapshot", agents: [child], canSelect: true });
    expect(state.select("pane", "run", "foreign")).toBe(false);
    expect(state.select("pane", "run", "child")).toBe(true);
    expect(state.read("pane", "run", true).selectedId).toBeNull();
    const { command } = state.report("pane", "run", { event: "snapshot", agents: [child] });
    expect(command?.agentId).toBe("child");
    expect(
      state.report("pane", "run", {
        event: "snapshot",
        agents: [child],
        selectedId: "child",
        acknowledged: command?.id,
      }),
    ).toEqual({});
    expect(state.read("pane", "run", true).selectedId).toBe("child");
    expect(state.select("pane", "run", null)).toBe(true);
  });
  test("discovery never grants navigation and dead parents lose children", () => {
    const state = new HarnessSubagents();
    state.report("pane", "run", { event: "start", agents: [child] });
    expect(state.select("pane", "run", "child")).toBe(false);
    expect(state.read("pane", "run", false).agents).toEqual([]);
  });
});

test("generic names stay distinct through updates and completion", () => {
  const state = new HarnessSubagents();
  const first = { ...child, id: "a", name: "default" };
  const second = { ...child, id: "b", name: "default" };
  const names = () => state.read("pane", "run", true).agents.map((agent) => agent.name);
  state.report("pane", "run", { event: "start", agents: [first, second, child] });
  expect(names()).toEqual(["Subagent 1", "Subagent 2", "Review"]);
  state.report("pane", "run", { event: "snapshot", agents: [second, first] });
  expect(names()).toEqual(["Subagent 2", "Subagent 1"]);
  state.report("pane", "run", { event: "stop", agentId: "a" });
  state.report("pane", "run", { event: "start", agents: [{ ...first, id: "c" }] });
  expect(names()).toEqual(["Subagent 2", "Subagent 3"]);
  state.report("pane", "run", { event: "reset" });
  state.report("pane", "run", { event: "start", agents: [first] });
  expect(names()).toEqual(["Subagent 1"]);
});
