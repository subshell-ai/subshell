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

/**
 * The stack's plates, oldest-anchored first. In a `flex flex-col` column the
 * DOM order IS the visual order, so "first child" is "highest top edge" and
 * the class on the column is the anchor both plates hang from.
 */
function plates(container: HTMLElement): HTMLElement[] {
  const stack = container.firstElementChild as HTMLElement;
  expect(stack.className).toContain("top-1");
  expect(stack.className).toContain("right-4");
  return [...stack.children] as HTMLElement[];
}

const isHud = (el: HTMLElement): boolean => el.textContent?.includes("Socket") ?? false;
const isBadge = (el: HTMLElement): boolean => el.textContent?.includes("⌨") ?? false;

describe("TerminalOverlayStack layout (the HUD never moves; the badge yields)", () => {
  it("the HUD's top edge is identical with the badge empty and with a keystroke pending", () => {
    // Badge empty: the HUD is the stack's only plate, at the anchor.
    const empty = renderStack(true, false);
    const emptyPlates = plates(empty.container);
    expect(emptyPlates).toHaveLength(1);
    expect(isHud(emptyPlates[0] as HTMLElement)).toBe(true);
    cleanup();

    // Badge at depth 1: the HUD is STILL the first plate, so its top edge is
    // the anchor's, unchanged from the empty case.
    const withPending = renderStack(true, true);
    const pendingPlates = plates(withPending.container);
    expect(pendingPlates).toHaveLength(2);
    expect(isHud(pendingPlates[0] as HTMLElement)).toBe(true);
    expect(pendingPlates[0]?.className).toBe(emptyPlates[0]?.className);
    // The badge is the yielding plate: after the HUD, exactly one gap below.
    expect(isBadge(pendingPlates[1] as HTMLElement)).toBe(true);
    cleanup();
  });

  it("with the HUD closed the badge keeps the corner to itself, at the anchor", () => {
    const { container } = renderStack(false, true);
    const stackPlates = plates(container);
    expect(stackPlates).toHaveLength(1);
    expect(isBadge(stackPlates[0] as HTMLElement)).toBe(true);
  });
});
