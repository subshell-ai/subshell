import type { Node } from "@/types/node";

/**
 * Pinned-profile re-anchor (spec §6.6, UI side) — the mobile mirror of the
 * web `new-session-form.tsx` decision of the same shape; change one, change
 * both (same posture as the label/selectability mirroring in `(tabs)/new.tsx`).
 *
 * When the selected profile pins a launch node and the user has NOT picked a
 * node since the profile change, the picker holds the pinned node — shown as
 * selected, offline and all, so a pinned-offline launch 409s exactly where
 * the picker points. The wire rule is unchanged (the create ternary still
 * omits `local`); this only makes the pinned pick honest on the wire. An
 * anchor the user's pick replaces stays replaced (Local included — the server
 * then re-applies the pin and the inline hint says so); an anchor that stops
 * being earned releases the pick back to "local", because it was never the
 * user's.
 */
export function anchorDecision(p: {
  /** The profile's pinned node row (list loaded, id present, not `local`); null otherwise */
  pinRow: Node | null;
  /** The user picked a node through the picker since the last profile change */
  explicit: boolean;
  /** The pick currently held by the screen */
  current: string;
  /** What the anchor auto-selected last, if it still owns the pick */
  anchoredTo: string | null;
}): { nodeId: string; anchoredTo: string | null } {
  if (p.pinRow && !p.explicit) return { nodeId: p.pinRow.id, anchoredTo: p.pinRow.id };
  if (!p.pinRow && !p.explicit && p.anchoredTo !== null && p.current === p.anchoredTo) {
    return { nodeId: "local", anchoredTo: null };
  }
  return { nodeId: p.current, anchoredTo: p.anchoredTo };
}
