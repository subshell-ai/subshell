import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { PaneDiagnosticsHud } from "@/components/pane-diagnostics-hud";
import { createInputQueue, type InputQueue } from "@/lib/input-queue";
import type { SubshellView } from "@/types/subshell";

afterEach(() => cleanup());

/** A full SubshellView with overridable fields; mirrors the actions-menu fixture. */
function makeSubshell(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "id-1",
    presetId: null,
    harnessId: "claude",
    nodeId: "node-9",
    nodeOffline: false,
    name: "subshell",
    nameLocked: false,
    workingDir: "/tmp/project",
    status: "running",
    createdAt: "2026-08-30T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: false,
    waitingSince: null,
    access: "owner",
    ...overrides,
  };
}

/** A clock the tests advance by hand, so ages and RTTs are exact. */
let nowMs = 10_000;
const now = () => nowMs;

/** A live queue: engaged (a current server's answer) with a recording sender. */
function liveQueue(): { queue: InputQueue; sent: string[] } {
  const sent: string[] = [];
  const queue = createInputQueue((data) => {
    sent.push(data);
    return true;
  }, now);
  queue.engage();
  return { queue, sent };
}

/** Refs as the terminal hands them over. */
const refOf = <T,>(value: T): { current: T } => ({ current: value });

/** Two settled viewers so describeDevices produces a grid. */
function viewersState() {
  const base = {
    label: "a device",
    since: "2026-09-21T00:00:00.000Z",
    hidden: false,
    canInput: true,
  };
  return {
    you: "me",
    sizing: { mode: "auto" as const, pinnedViewerId: null },
    viewers: [
      { id: "me", ...base, capacity: { cols: 120, rows: 40 } },
      { id: "other", ...base, capacity: { cols: 50, rows: 16 } },
    ],
  };
}

function renderHud(props: Partial<Parameters<typeof PaneDiagnosticsHud>[0]> = {}) {
  return render(
    <PaneDiagnosticsHud
      subshell={makeSubshell()}
      socket={{ connected: true, closed: false }}
      reconnectsRef={refOf(0)}
      inputQueueRef={refOf<InputQueue | null>(null)}
      viewers={viewersState()}
      nodeLabel="mac-mini"
      {...props}
    />,
  );
}

describe("PaneDiagnosticsHud rows", () => {
  it("socket: open, reconnecting with a count, and closed", () => {
    renderHud();
    expect(screen.getByText("open")).toBeTruthy();
    cleanup();

    renderHud({ socket: { connected: false, closed: false }, reconnectsRef: { current: 1 } });
    expect(screen.getByText("reconnecting · 1 reconnect")).toBeTruthy();
    cleanup();

    renderHud({ socket: { connected: false, closed: false }, reconnectsRef: { current: 3 } });
    expect(screen.getByText("reconnecting · 3 reconnects")).toBeTruthy();
    cleanup();

    renderHud({ socket: { connected: false, closed: true } });
    expect(screen.getByText("closed")).toBeTruthy();
  });

  it("node: the resolved label, the unreachable word from the row, and the unknown fallback", () => {
    renderHud();
    expect(screen.getByText("mac-mini")).toBeTruthy();
    cleanup();

    renderHud({ subshell: makeSubshell({ nodeOffline: true }) });
    expect(screen.getByText("mac-mini · unreachable")).toBeTruthy();
    cleanup();

    renderHud({ nodeLabel: null, subshell: undefined });
    expect(screen.getByText("unknown node")).toBeTruthy();
  });

  it("pane: the row's alive fact plus the SHARED indicator word", () => {
    renderHud({ subshell: makeSubshell({ activity: "idle", lastOutputAt: null }) });
    expect(screen.getByText("alive · idle")).toBeTruthy();
    cleanup();

    renderHud({
      subshell: makeSubshell({
        alive: false,
        status: "running",
        exitCode: 1,
        activity: "idle",
        lastOutputAt: null,
      }),
    });
    // The exit code is the row's own fact; the shared indicator says the same
    // thing ("exited") and is not repeated.
    expect(screen.getByText("exited (code 1)")).toBeTruthy();
  });

  it("output: none yet, just now, and the elapsed age on the shared clock", () => {
    renderHud({ subshell: makeSubshell({ lastOutputAt: null }) });
    expect(screen.getByText("none yet")).toBeTruthy();
    cleanup();

    renderHud({ subshell: makeSubshell({ lastOutputAt: new Date(Date.now()).toISOString() }) });
    expect(screen.getByText("just now")).toBeTruthy();
    cleanup();

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    renderHud({ subshell: makeSubshell({ lastOutputAt: twoHoursAgo }) });
    expect(screen.getByText("2h ago")).toBeTruthy();
  });

  it("input: unknown without a queue, idle when empty, and the in-flight/waiting split under backpressure", async () => {
    renderHud({ inputQueueRef: refOf<InputQueue | null>(null) });
    expect(screen.getByText("unknown")).toBeTruthy();
    cleanup();

    const { queue } = liveQueue();
    renderHud({ inputQueueRef: refOf(queue) });
    expect(screen.getByText("idle")).toBeTruthy();
    cleanup();

    const backed = liveQueue();
    backed.queue.enqueue("a"); // fast path: sent, unacked
    backed.queue.enqueue("b"); // coalesces into the unsent tail
    renderHud({ inputQueueRef: refOf(backed.queue) });
    expect(screen.getByText("1 in flight · 1 waiting")).toBeTruthy();
  });

  it("input: the echo figures and the stall age ride the muted detail line", async () => {
    const { queue } = liveQueue();
    queue.enqueue("a");
    nowMs += 40;
    act(() => queue.ack(1)); // one 40 ms round trip
    queue.enqueue("b"); // now unacked
    nowMs += 2500; // it has waited past the stall threshold
    const { container } = renderHud({ inputQueueRef: refOf(queue) });
    expect(screen.getByText(/echo p50 40 ms · max 40 ms/)).toBeTruthy();
    expect(screen.getByText(/oldest 2.5 s unacked/)).toBeTruthy();
    // The stall shares the badge's threshold: the input row reads amber.
    expect(container.querySelector(".text-warning")).toBeTruthy();
  });

  it("input: a queue that never engaged says so instead of implying acks are coming", () => {
    const bare = createInputQueue(() => true, now);
    renderHud({ inputQueueRef: refOf(bare) });
    expect(screen.getByText("idle · no acks")).toBeTruthy();
  });

  it("viewers: the count and the settled grid from the shared devices rules", () => {
    renderHud();
    expect(screen.getByText("2 devices · 50×16")).toBeTruthy();
    cleanup();

    renderHud({ viewers: null });
    expect(screen.getByText("socket down")).toBeTruthy();
  });
});
