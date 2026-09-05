import type { ViewerPresence } from "./frames.js";
import { decideSharedGrid, type Grid, type SizingPolicy } from "./shared-geometry.js";

/**
 * The `viewers` frame's payload, as any client holds it.
 *
 * Named here rather than in each client because all THREE of them need it now
 * — the web header, a workspace pane, and the phone — and the roles below are
 * derived from it identically. A per-client copy is how the browser's
 * explanation once drifted from the server's behaviour by one field.
 */
export interface ViewersState {
  /** Which entry in {@link viewers} is this client. */
  you: string;
  /** Everyone attached, including this client. */
  viewers: ViewerPresence[];
  /** How the pane's grid is currently being decided. */
  sizing: SizingPolicy & { mode: "auto" | "pinned"; pinnedViewerId: string | null };
}

/**
 * What one device is doing to the pane's size right now.
 *
 * - `pinned` — the operator named this screen; it decides alone.
 * - `size` / `width` / `height` — under smallest-wins, this device is what
 *   holds the pane where it is, on both axes or on one.
 * - `hidden` — not being rendered, so it takes no part at all.
 * - `spare` — bigger than the pane on both axes; it letterboxes and loses
 *   nothing.
 */
export type DeviceRole = "pinned" | "size" | "width" | "height" | "hidden" | "spare";

/** One row of the devices list. */
export interface DeviceRow {
  /** The viewer as the server reported it. */
  viewer: ViewerPresence;
  /** True for the device the user is looking at. */
  you: boolean;
  /** What this device does to the pane's size. */
  role: DeviceRole;
}

/** The devices list, ready to render. */
export interface DeviceReport {
  /** Every attached device, this one first, then by attach time. */
  rows: DeviceRow[];
  /** The grid the rules produce for this viewer set, or null. */
  grid: Grid | null;
  /**
   * False while every device is mid-layout (the degenerate fallback). Roles
   * are meaningless then — the grid is a stopgap the next settled report
   * supersedes — so the UI stays quiet rather than blaming a device for a
   * size that is about to change on its own.
   */
  settled: boolean;
}

/**
 * Turns a `viewers` frame into the list a user can act on: who is watching,
 * and which of them is the reason the terminal is the size it is.
 *
 * The size decision is NOT re-implemented here — it calls the same
 * `decideSharedGrid` the server applies, from the shared protocol package, so
 * the explanation cannot drift from the behavior it explains.
 *
 * @param state - The latest `viewers` frame
 * @returns Rows in display order, plus the grid they produce
 */
export function describeDevices(state: ViewersState): DeviceReport {
  const decision = decideSharedGrid(
    // EVERY field the rule reads, or the explanation contradicts the thing it
    // explains. Dropping `canInput` put a `view` grantee back in the top rung
    // here while the server had already excluded it: the pane said 120x40 and
    // this list said "Pane is 50x16 — sized so every device fits", blamed the
    // guest for a size it was not causing, and offered a pin that appeared to
    // do nothing.
    state.viewers.map((v) => ({
      id: v.id,
      capacity: v.capacity,
      hidden: v.hidden,
      canInput: v.canInput,
    })),
    state.sizing,
  );
  const settled = decision !== null && decision.reason !== "fallback";
  const holdsWidth = new Set(decision?.cols ?? []);
  const holdsHeight = new Set(decision?.rows ?? []);

  const rows = state.viewers.map((viewer) => ({
    viewer,
    you: viewer.id === state.you,
    role: roleOf(viewer, { settled, holdsWidth, holdsHeight, pinned: decision?.reason === "pinned" }),
  }));

  // This device first — it is the one the reader can do something about
  // (resize the window, background the tab) — then oldest attach first so the
  // list does not reshuffle as devices resize.
  rows.sort((a, b) => Number(b.you) - Number(a.you) || a.viewer.since.localeCompare(b.viewer.since));
  return { rows, grid: decision?.grid ?? null, settled };
}

/** The role of one viewer given a settled decision. See {@link DeviceRole}. */
function roleOf(
  viewer: ViewerPresence,
  ctx: { settled: boolean; holdsWidth: Set<string>; holdsHeight: Set<string>; pinned: boolean },
): DeviceRole {
  // Hidden outranks everything EXCEPT a pin: a pinned device keeps deciding
  // while backgrounded (that is the point of pinning), so calling it "not
  // taking part" would be a lie the user could act on.
  const decides = ctx.holdsWidth.has(viewer.id) || ctx.holdsHeight.has(viewer.id);
  if (ctx.pinned && decides) return "pinned";
  if (viewer.hidden) return "hidden";
  if (!ctx.settled) return "spare";
  const w = ctx.holdsWidth.has(viewer.id);
  const h = ctx.holdsHeight.has(viewer.id);
  if (w && h) return "size";
  if (w) return "width";
  if (h) return "height";
  return "spare";
}

/** Short human label for a role, or null when there is nothing worth saying. */
export function roleLabel(role: DeviceRole): string | null {
  switch (role) {
    case "pinned":
      return "pinned";
    case "size":
      return "sets size";
    case "width":
      return "sets width";
    case "height":
      return "sets height";
    case "hidden":
      return "hidden";
    // A device with room to spare explains nothing about the pane's size, and
    // labelling every one of them turns the list into noise.
    case "spare":
      return null;
  }
}
