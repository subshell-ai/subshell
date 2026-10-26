import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { TerminalOverlayStack } from "@/components/subshell-terminal";
import { createInputQueue, type InputQueue } from "@/lib/input-queue";
import type { SubshellView } from "@/types/subshell";

afterEach(() => cleanup());

/** A full SubshellView; the HUD reads a handful of fields off it. */
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
    ssh: false,
    ...overrides,
  };
}

/** A clock the tests advance by hand, so queue ages are exact. */
const nowMs = 10_000;
const now = () => nowMs;

/** An engaged queue; `pending` decides whether a keystroke is waiting. */
function queueWith(pending: boolean): InputQueue {
  const queue = createInputQueue(() => true, now);
  queue.engage();
  if (pending) queue.enqueue("a"); // fast path: sent, unacked
  return queue;
}

/** Refs as the terminal hands them over. */
const refOf = <T,>(value: T): { current: T } => ({ current: value });

function renderStack(diagnostics: boolean, pending: boolean) {
  return render(
    <TerminalOverlayStack
      inputQueueRef={refOf<InputQueue | null>(queueWith(pending))}
      diagnostics={
        diagnostics
          ? {
              subshell: makeSubshell(),
              socket: { connected: true, closed: false },
              reconnectsRef: refOf(0),
              viewers: null,
              nodeLabel: "mac-mini",
              lastOutputRef: refOf<number | null>(null),
            }
          : null
      }
    />,
  );
}

describe("TerminalOverlayStack diagnostics visibility", () => {
  it("with diagnostics off the stack renders nothing, even with a keystroke pending", () => {
    // Issue #243: the badge is diagnostic text, so it exists only inside the
    // diagnostics state. Normal typing leaves this corner of the screen
    // entirely out of the repaint.
    const { container } = renderStack(false, true);
    expect(container.firstElementChild).toBeNull();
  });
});
