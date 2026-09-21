import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { InputQueueBadge } from "@/components/subshell-terminal";
import { createInputQueue, type InputQueue, queueBadgeView } from "@/lib/input-queue";

afterEach(() => cleanup());

describe("queueBadgeView", () => {
  it("shows the depth and reads amber past the stall threshold", () => {
    expect(queueBadgeView({ depth: 3, unackedOldestMs: 100 })).toEqual({ depth: 3, stalled: false });
    expect(queueBadgeView({ depth: 1, unackedOldestMs: 2001 })).toEqual({ depth: 1, stalled: true });
    // Exactly at the threshold is not yet stalled: the badge turns amber
    // when a keystroke has WAITED past 2 s, not when it reached it.
    expect(queueBadgeView({ depth: 1, unackedOldestMs: 2000 }).stalled).toBe(false);
    expect(queueBadgeView({ depth: 0, unackedOldestMs: null })).toEqual({ depth: 0, stalled: false });
  });
});

describe("InputQueueBadge", () => {
  /** A clock the test advances by hand, so the stall threshold is exact. */
  let nowMs: number;
  const now = () => nowMs;

  const refFor = (queue: InputQueue | null): { current: InputQueue | null } => ({ current: queue });

  it("renders the pending count while the queue holds input, and nothing once it drains", async () => {
    nowMs = 0;
    const queue = createInputQueue(() => undefined, now);
    queue.engage();
    queue.enqueue("a");
    const { container } = render(<InputQueueBadge inputQueueRef={refFor(queue)} />);
    expect(screen.getByText("1 ⌨", { exact: false })).toBeTruthy();
    expect(container.querySelector(".text-warning")).toBeNull();
    act(() => queue.ack(1));
    // The ack drains through the queue's rAF-coalesced listener; let one turn run.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("turns amber once the oldest unacked id has waited past 2 s", () => {
    nowMs = 0;
    const queue = createInputQueue(() => undefined, now);
    queue.engage();
    queue.enqueue("a");
    nowMs = 2500; // one keystroke, unacked, 2.5 s old
    const { container } = render(<InputQueueBadge inputQueueRef={refFor(queue)} />);
    expect(container.querySelector(".text-warning")).toBeTruthy();
  });

  it("renders nothing when the queue is empty or not yet attached", () => {
    const { container } = render(<InputQueueBadge inputQueueRef={refFor(null)} />);
    expect(container.textContent).toBe("");
  });
});
