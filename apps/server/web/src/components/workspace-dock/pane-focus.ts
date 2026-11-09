import type { PaneFocus, PaneFocusOutcome } from "@/components/workspace-dock/context";

/**
 * The dock's per-pane focus handoff.
 *
 * A tab click can arrive before the pane's terminal exists (activation builds
 * it) or while the old terminal is being disposed, so the request is held
 * until a publish answers it. A handoff that ended `retired` (its terminal
 * left the DOM) leaves the request in place for the replacement's publish;
 * `focused` or `abandoned` closes it.
 */
export interface PaneFocusRegistry {
  /** Requests focus for a pane; the click's own focus is the baseline. */
  request(paneId: string): void;
  /** Publishes the mounted terminal's handoff, or clears it on dispose. */
  publish(paneId: string, focus: PaneFocus | null): void;
  /** Drops an outstanding request for a pane that left the dock. */
  drop(paneId: string): void;
}

export function createPaneFocusRegistry(): PaneFocusRegistry {
  const targets = new Map<string, PaneFocus>();
  const pending = new Map<string, Element | null>();

  const settle = (paneId: string, outcome: PaneFocusOutcome) => {
    // A retired terminal is not an answer: the replacement's publish retries.
    if (outcome !== "retired") pending.delete(paneId);
  };

  return {
    request(paneId) {
      const initial = document.activeElement;
      pending.set(paneId, initial);
      targets.get(paneId)?.(initial, (outcome) => settle(paneId, outcome));
    },
    publish(paneId, focus) {
      if (!focus) {
        targets.delete(paneId);
        return;
      }
      targets.set(paneId, focus);
      if (pending.has(paneId)) focus(pending.get(paneId) ?? null, (outcome) => settle(paneId, outcome));
    },
    drop(paneId) {
      pending.delete(paneId);
    },
  };
}
