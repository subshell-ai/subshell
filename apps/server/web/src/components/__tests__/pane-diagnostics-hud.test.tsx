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
    unseenPush: false,
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
      lastOutputRef={refOf<number | null>(null)}
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

  it("pane: a terminated row reads the shared word, not exited-and-ended for one state", () => {
    renderHud({
      subshell: makeSubshell({
        status: "terminated",
        alive: false,
        exitCode: 2,
        activity: "terminated",
        lastOutputAt: null,
      }),
    });
    expect(screen.getByText("ended (code 2)")).toBeTruthy();
    expect(screen.queryByText(/exited/)).toBeNull();
  });

  it("output: bytes seen here lead; the row's stamp only answers when none arrived", () => {
    // An attached socket that has received NOTHING yet says so — the row's
    // stamp cannot speak for this viewer (the feed only re-sends on domain
    // events, which is the "3m ago while typing" this row used to lie about).
    renderHud({ subshell: makeSubshell({ lastOutputAt: null }) });
    expect(screen.getByText("waiting…")).toBeTruthy();
    cleanup();

    // A byte arrived moments ago: live, whatever the stale row claims.
    renderHud({
      subshell: makeSubshell({ lastOutputAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() }),
      lastOutputRef: refOf(Date.now() - 200),
    });
    expect(screen.getByText("live")).toBeTruthy();
    cleanup();

    renderHud({ lastOutputRef: refOf(Date.now() - 3 * 60 * 1000) });
    expect(screen.getByText("3m ago")).toBeTruthy();
    cleanup();

    // No socket and no bytes: only then the row's own server-side fact.
    renderHud({ subshell: makeSubshell({ lastOutputAt: null }), socket: { connected: false, closed: false } });
    expect(screen.getByText("none yet")).toBeTruthy();
    cleanup();

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    renderHud({
      subshell: makeSubshell({ lastOutputAt: twoHoursAgo }),
      socket: { connected: false, closed: false },
    });
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

  it("input: the echo figures and the stall age each ride their own row", () => {
    const { queue } = liveQueue();
    queue.enqueue("a");
    nowMs += 40;
    act(() => queue.ack(1)); // one 40 ms round trip
    queue.enqueue("b"); // now unacked
    nowMs += 2500; // it has waited past the stall threshold
    const { container } = renderHud({ inputQueueRef: refOf(queue) });
    // One number per row: the joined detail line these replaced made a
    // moving p50 unscannable, and the operator asked for their own lines.
    expect(screen.getByText("Echo p50")).toBeTruthy();
    expect(screen.getByText("Echo max")).toBeTruthy();
    expect(screen.getAllByText("40 ms").length).toBe(2);
    expect(screen.getByText("Oldest")).toBeTruthy();
    expect(screen.getByText("2.5 s unacked")).toBeTruthy();
    // The stall shares the badge's threshold: the input row reads amber.
    expect(container.querySelector(".text-warning")).toBeTruthy();
  });

  it("rows: Viewers sits above Output, and the Input echo rows close the list", () => {
    const { queue } = liveQueue();
    queue.enqueue("a");
    act(() => queue.ack(1));
    const { container } = renderHud({ inputQueueRef: refOf(queue) });
    const labels = [...container.querySelectorAll(".text-muted-foreground")].map((el) => el.textContent);
    expect(labels).toEqual(["Socket", "Node", "Pane", "Viewers", "Output", "Input", "Echo p50", "Echo max"]);
  });

  it("input: a queue that never engaged says starting pre-answer, no acks once answered", () => {
    // The approximation the HUD documents: unengaged on the FIRST attach is
    // the innocent pre-engage window (the server has not answered yet), so it
    // reads "starting"; surviving a reconnect and still unengaged means the
    // server answered without inputAcks, and THAT is what "no acks" claims.
    const bare = createInputQueue(() => true, now);
    renderHud({ inputQueueRef: refOf(bare), reconnectsRef: refOf(0) });
    expect(screen.getByText("starting")).toBeTruthy();
    cleanup();

    const answered = createInputQueue(() => true, now);
    renderHud({ inputQueueRef: refOf(answered), reconnectsRef: refOf(2) });
    expect(screen.getByText("idle · no acks")).toBeTruthy();
  });

  it("viewers: settled grid, settling before the first frame, socket down only on a refusal", () => {
    renderHud();
    expect(screen.getByText("2 devices · 50×16")).toBeTruthy();
    cleanup();

    // No frame yet while the socket is up (the first viewers frame follows
    // the replay): settling, never "socket down".
    renderHud({ viewers: null });
    expect(screen.getByText("settling")).toBeTruthy();
    cleanup();

    renderHud({ viewers: null, socket: { connected: false, closed: true } });
    expect(screen.getByText("socket down")).toBeTruthy();
  });
});
