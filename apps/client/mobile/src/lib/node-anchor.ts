import type { Node } from "@/types/node";

/**
 * Whether a node is pickable right now — the mobile mirror of the web
 * `new-subshell-form.tsx` `isSelectable`; change one, change both. Any share
 * grants launch (`nodeCanLaunch` — deliberately not the subshell rule,
 * spec §2), EXCEPT where the server says otherwise: `canLaunch` is false on
 * the control-plane host once an admin switches launching off there, which
 * applies to admins too and is the one visible-but-unlaunchable row in the
 * product (2026-09-12). Without reading it, an admin who threw that switch
 * would still see the Server chip here and collect a 403 on Start. An
 * OFFLINE agent is shown disabled for its own reason: launching there 409s
 * `NODE_OFFLINE`, and offering a target we know is down would only invite a
 * confusing failure. (The pick list can always be stale — the 409 path covers
 * the race.) Shared by the chip row and `pickNodeDefault` so "selectable" is
 * defined exactly once.
 */
export function isSelectable(n: Node): boolean {
  return (n.kind === "local" || n.status === "online") && n.canLaunch !== false;
}

/**
 * The node the picker should hold once the list has loaded — the mobile
 * mirror of the web `new-subshell-form.tsx` `pickNodeDefault`; change one,
 * change both. Keep the current pick while it stays selectable; else the
 * pick vanished (or went unselectable) and exactly one option remains
 * (auto-pick — not a decision worth forcing); else `""` — an explicit choice
 * is due and Start stays blocked until it happens. Pure so the fallback
 * matrix is testable without a device, like `anchorDecision`.
 */
export function pickNodeDefault(nodes: Node[], current: string): string {
  if (nodes.some((n) => n.id === current && isSelectable(n))) return current;
  const selectable = nodes.filter(isSelectable);
  if (selectable.length === 1) return selectable[0].id;
  return "";
}

/**
 * Pinned-profile re-anchor (spec §6.6, UI side) — the shapes now DELIBERATELY
 * differ from the web: web renamed this decision to `suggestDecision` and
 * earned-gates it (the suggestion owns the pick only when the pinned row is
 * visible, online, AND compatible), while mobile keeps the old keep-offline-pin
 * anchor semantics here (spec 2026-09-02 pairing non-goal — a mobile pass is
 * follow-up). Do NOT blind-sync with the web; unlike the label/selectability
 * mirroring in `(tabs)/new.tsx`.
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
