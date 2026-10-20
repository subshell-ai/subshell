import { describe, expect, test } from "bun:test";
import { HarnessSubagents } from "../harness-subagents.js";

const child = { id: "child", name: "Review", status: "running" as const };

/** Drops the server's own stamp so lifecycle assertions can read against plain payloads. */
function bare(agents: { startedAt: number }[]) {
  return agents.map(({ startedAt: _stamp, ...rest }) => rest);
}

describe("harness subagents", () => {
  test("lifecycle removes completed children and restart discards old state", () => {
    const state = new HarnessSubagents();
    state.report("pane", "first", { event: "start", agents: [child] });
    expect(bare(state.read("pane", "first", true).agents)).toEqual([child]);
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
  test("a pane that can select and answers carries no unavailableReason", () => {
    // The field description promises a reason exactly when selection is off.
    // The old shape attached the "doesn't support switching" default to
    // WORKING panes too, contradicting its own `canSelect: true`.
    const state = new HarnessSubagents();
    state.report("pane", "run", { event: "snapshot", agents: [child], canSelect: true });
    const snapshot = state.read("pane", "run", true);
    expect(snapshot.canSelect).toBe(true);
    expect(snapshot.unavailableReason).toBeUndefined();
    // A harness that says it cannot keeps its own reason, and an unsaid one
    // gets the default.
    state.report("pane", "run", { event: "snapshot", agents: [child], canSelect: false });
    expect(state.read("pane", "run", true).unavailableReason).toContain("doesn't support");
    // A harness that "explains" itself with whitespace gets the default too:
    // a reason that renders as nothing is an empty tooltip.
    state.report("pane", "run", { event: "snapshot", agents: [child], unavailableReason: "  " });
    expect(state.read("pane", "run", true).unavailableReason).toContain("doesn't support");
  });
  test("discovery never grants navigation and dead parents lose children", () => {
    const state = new HarnessSubagents();
    state.report("pane", "run", { event: "start", agents: [child] });
    expect(state.select("pane", "run", "child")).toBe(false);
    expect(state.read("pane", "run", false).agents).toEqual([]);
  });
});

test("describe labels pair with the next child of their type", () => {
  const state = new HarnessSubagents();
  // Claude Code fires PreToolUse BEFORE SubagentStart, so the label arrives
  // first; FIFO per type pairs the fan-out case (four reviewers, four labels)
  // in spawn order.
  state.report("pane", "run", { event: "describe", agentType: "code-reviewer", activity: "Reading the diff" });
  state.report("pane", "run", { event: "describe", agentType: "code-reviewer", activity: "Checking the tests" });
  state.report("pane", "run", { event: "describe", agentType: "scout", activity: "Mapping the repo" });
  state.report("pane", "run", { event: "start", agents: [{ id: "a", name: "code-reviewer", status: "running" }] });
  state.report("pane", "run", { event: "start", agents: [{ id: "b", name: "code-reviewer", status: "running" }] });
  const agents = state.read("pane", "run", true).agents;
  expect(agents.map((agent) => agent.activity)).toEqual(["Reading the diff", "Checking the tests"]);
  // An inline label (hermes's goal) wins over anything parked for the type,
  // and a scout starting next takes the one queued for scouts.
  state.report("pane", "run", {
    event: "start",
    agents: [{ id: "c", name: "code-reviewer", status: "running", activity: "Verifying findings" }],
  });
  state.report("pane", "run", { event: "start", agents: [{ id: "d", name: "scout", status: "running" }] });
  expect(
    state
      .read("pane", "run", true)
      .agents.filter((agent) => agent.id === "c" || agent.id === "d")
      .map((agent) => agent.activity),
  ).toEqual(["Verifying findings", "Mapping the repo"]);
});

test("unclaimed labels are capped, and a type's labels never cross to another type", () => {
  const state = new HarnessSubagents();
  for (let i = 0; i < 10; i++)
    state.report("pane", "run", { event: "describe", agentType: "worker", activity: `Label ${i}` });
  state.report("pane", "run", { event: "describe", agentType: "other", activity: "Elsewhere" });
  state.report("pane", "run", { event: "start", agents: [{ id: "w", name: "worker", status: "running" }] });
  const started = state.read("pane", "run", true).agents.find((agent) => agent.id === "w");
  // Ten pushes at a cap of eight drop the two oldest; Label 2 is next up.
  expect(started?.activity).toBe("Label 2");
  // A start whose name no queue matches leaves the child unlabeled rather
  // than stealing some other type's label.
  state.report("pane", "run", { event: "start", agents: [{ id: "x", name: "unmatched", status: "running" }] });
  expect(state.read("pane", "run", true).agents.find((agent) => agent.id === "x")?.activity).toBeUndefined();
});

test("a periodic snapshot keeps first-sighting stamps and issued labels", () => {
  const state = new HarnessSubagents();
  state.report("pane", "run", { event: "start", agents: [child] });
  const first = state.read("pane", "run", true).agents[0];
  state.report("pane", "run", { event: "snapshot", agents: [child] });
  const again = state.read("pane", "run", true).agents[0];
  // Elapsed time must survive the bridge's periodic re-list, and so must a
  // label the harness does not repeat in later passes.
  expect(again.startedAt).toBe(first?.startedAt);
});

test("a flood of distinct agent types is bounded by the oldest key leaving", () => {
  const state = new HarnessSubagents();
  // agentType is pane-chosen text; every distinct value could otherwise
  // plant a permanent Map key. Sixty-four types, oldest evicted first.
  for (let i = 0; i < 70; i++)
    state.report("pane", "run", { event: "describe", agentType: `type-${i}`, activity: `Label ${i}` });
  state.report("pane", "run", { event: "start", agents: [{ id: "z", name: "type-69", status: "running" }] });
  expect(state.read("pane", "run", true).agents.find((a) => a.id === "z")?.activity).toBe("Label 69");
  // The oldest types are gone: type-0 can no longer label its child.
  state.report("pane", "run", { event: "start", agents: [{ id: "o", name: "type-0", status: "running" }] });
  expect(state.read("pane", "run", true).agents.find((a) => a.id === "o")?.activity).toBeUndefined();
});

test("fifteen seconds of silence flips selection off and refuses a queue", () => {
  const state = new HarnessSubagents();
  state.report("pane", "run", { event: "snapshot", agents: [child], canSelect: true, selectedId: "child" });
  // The harness stopped answering; its hooks are dead, so navigation would
  // queue into nothing. The roster stays visible, the door closes with the
  // reason that names the silence, and select refuses outright.
  const realNow = Date.now;
  Date.now = () => realNow() + 15_001;
  try {
    const snapshot = state.read("pane", "run", true);
    expect(snapshot.canSelect).toBe(false);
    expect(snapshot.unavailableReason).toContain("isn't responding");
    expect(state.select("pane", "run", null)).toBe(false);
  } finally {
    Date.now = realNow;
  }
  // One fresh report revives the pane: silence was the only complaint.
  state.report("pane", "run", { event: "snapshot", agents: [child], canSelect: true });
  expect(state.read("pane", "run", true).canSelect).toBe(true);
});

test("a queued command rides the next report, expires in five seconds, and dies with a reset", () => {
  const state = new HarnessSubagents();
  state.report("pane", "run", { event: "snapshot", agents: [child], canSelect: true });
  expect(state.select("pane", "run", "child")).toBe(true);
  const realNow = Date.now;
  Date.now = () => realNow() + 5_001;
  try {
    // Queueing is not a promise: five seconds without an acknowledgement and
    // the report carries nothing, because the viewer's read shows the view
    // that never moved.
    expect(state.report("pane", "run", { event: "snapshot", agents: [child] })).toEqual({});
    // A second, unexpired command still dies with a reset: the conversation
    // that would have carried it is gone.
    expect(state.select("pane", "run", "child")).toBe(true);
  } finally {
    Date.now = realNow;
  }
  expect(state.report("pane", "run", { event: "reset" })).toEqual({});
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
