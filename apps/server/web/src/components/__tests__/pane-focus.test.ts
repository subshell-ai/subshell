import { describe, expect, it } from "bun:test";
import type { PaneFocus, PaneFocusOutcome } from "../workspace-dock/context";
import { createPaneFocusRegistry } from "../workspace-dock/pane-focus";

/** Stands in for one terminal publish: the registry calls it with the click. */
function recorder() {
  const attempts: { initial: Element | null; settle: (outcome: PaneFocusOutcome) => void }[] = [];
  const focus: PaneFocus = (initial, settle) => attempts.push({ initial, settle });
  return { attempts, focus };
}

describe("pane focus registry", () => {
  it("hands a request to a live terminal with the click's own focus", () => {
    const registry = createPaneFocusRegistry();
    const clicked = document.createElement("button");
    document.body.append(clicked);
    clicked.focus();
    const live = recorder();
    registry.publish("pane-1", live.focus);
    registry.request("pane-1");
    clicked.remove();
    expect(live.attempts).toHaveLength(1);
    expect(live.attempts[0].initial).toBe(clicked);
  });

  it("holds the click for a terminal that mounts after it", () => {
    const registry = createPaneFocusRegistry();
    registry.request("pane-1");
    const late = recorder();
    registry.publish("pane-1", late.focus);
    expect(late.attempts).toHaveLength(1);
  });

  it("hands the same click to the replacement of a retired terminal", () => {
    const registry = createPaneFocusRegistry();
    const doomed = recorder();
    registry.publish("pane-1", doomed.focus);
    registry.request("pane-1");
    doomed.attempts[0].settle("retired");
    // Activation disposes the old terminal before building the new one.
    registry.publish("pane-1", null);
    const replacement = recorder();
    registry.publish("pane-1", replacement.focus);
    expect(replacement.attempts).toHaveLength(1);
    expect(replacement.attempts[0].initial).toBe(doomed.attempts[0].initial);
  });

  it("does not replay a handoff that ended on its own terms", () => {
    for (const outcome of ["focused", "abandoned"] as const) {
      const registry = createPaneFocusRegistry();
      const first = recorder();
      registry.publish("pane-1", first.focus);
      registry.request("pane-1");
      first.attempts[0].settle(outcome);
      const next = recorder();
      registry.publish("pane-1", next.focus);
      expect(next.attempts).toHaveLength(0);
    }
  });

  it("drops a request for a pane that left the dock", () => {
    const registry = createPaneFocusRegistry();
    registry.request("pane-1");
    registry.drop("pane-1");
    const late = recorder();
    registry.publish("pane-1", late.focus);
    expect(late.attempts).toHaveLength(0);
  });
});
