import type { Node } from "@internal/node-admin";
import { isOfflineAgent } from "@/lib/node-label";

/**
 * The launch form's pure contract: the value the caller owns, the submit
 * gate, the node-pick rules, and the field-id sets. Split out of
 * `new-subshell-form.tsx` on 2026-09-25 so the component file holds the
 * component; every function here is pure precisely so the pick matrix is
 * testable without opening a dropdown.
 */

/** The fields needed to launch a new subshell (spec 2026-09-13 §5). */
export interface NewSubshellFormValue {
  /** Agent (plugin) to launch — the one required choice */
  harnessId: string;
  /** Preset to launch from; null = "None", a real presetless launch */
  presetId: string | null;
  /**
   * Launch node — defaults to "local" (the control-plane host). "" means no
   * valid choice is made yet (local vanished from the list with several other
   * nodes around), which blocks submit until the user picks one.
   */
  nodeId: string;
  workingDir: string;
}

export function emptyNewSubshellForm(): NewSubshellFormValue {
  return { harnessId: "", presetId: null, workingDir: "", nodeId: "local" };
}

/** True once the form has everything the create call requires. */
export function canSubmit(value: NewSubshellFormValue): boolean {
  return Boolean(value.harnessId) && Boolean(value.workingDir.trim()) && Boolean(value.nodeId);
}

/**
 * Whether a node is pickable right now: an OFFLINE agent is shown disabled —
 * launching there 409s `NODE_OFFLINE`, and offering a target we know is down
 * would only invite a confusing failure. (The pick list can always be stale;
 * the 409 path covers the race.) Harness compatibility greys separately, via
 * `buildNodeOptions`. Mirrored in mobile `src/lib/node-pick.ts`.
 */
export function isSelectable(n: Node): boolean {
  // `canLaunch` is the SERVER's answer to "may this viewer start a subshell
  // here", and the one node that can be visible without it is the
  // control-plane host nobody is granted launch access on (spec 2026-09-12).
  //
  // Maintenance is checked SEPARATELY even though the server already ANDs it
  // into `canLaunch` (spec 2026-09-14): this row is the one unlaunchable node
  // the list keeps, so a payload cached before the flip would otherwise offer
  // a launch the node itself refuses at the pane.
  return !isOfflineAgent(n) && n.canLaunch && !n.maintenance;
}

/**
 * The machines this picker LISTS — launchable, plus the one unlaunchable kind
 * worth showing.
 *
 * A host narrowed by its shares is FILTERED rather than greyed: a greyed row
 * is a choice with a reason, and "the host you were never granted" is not a
 * choice at all — the empty state says what to do about it, once,
 * instead of every row saying it. A node in MAINTENANCE is kept and greyed
 * (spec 2026-09-14 §6), because it is a choice with a reason and a way back:
 * somebody is working on that machine, it will take subshells again, and
 * whoever manages it can end the window from its page. Hiding it would leave
 * a person hunting for a node that had simply vanished.
 */
export function launchableNodes(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.canLaunch || n.maintenance);
}

/**
 * Whether to hide the machine field entirely.
 *
 * Only when the SOLE target is the control-plane host — a fresh install, where
 * the row reads "Server · darwin/arm64" and the question it answers has not
 * occurred to anyone yet (operator's call, 2026-09-12). A single AGENT node
 * keeps the field: once a second machine exists at all, where a subshell runs
 * is worth stating.
 *
 * Pure, like `pickNodeDefault`, so the matrix is testable without opening a
 * dropdown.
 */
export function hideMachineField(nodes: Node[]): boolean {
  const targets = launchableNodes(nodes);
  const sole = targets.length === 1 ? targets[0] : undefined;
  // The rule is "one possible answer, so no question" — which means the sole
  // row has to BE an answer. A host in maintenance is zero answers, not one,
  // and that screen is no longer this function's to get right: the form
  // returns `NoLaunchTargets` before it reaches here whenever nothing is
  // selectable, which covers the sole-host-in-maintenance case completely.
  // The check stays as a belt against a caller that renders the fields
  // without that gate — a form whose one field offers only a greyed row is a
  // question with no answer, and hiding it makes the dead end silent.
  return sole !== undefined && sole.kind === "local" && isSelectable(sole);
}

/**
 * The node the picker should hold once the list has loaded: keep the current
 * pick while it stays selectable; else auto-pick the SOLE remaining selectable
 * option (typically an agent when Local is gone — not a decision worth
 * forcing); else "" — an explicit choice is due (submit stays blocked until
 * it happens).
 * Pure so the fallback matrix is testable without opening a dropdown.
 * Mirrored in mobile `src/lib/node-pick.ts`.
 */
export function pickNodeDefault(nodes: Node[], current: string): string {
  if (nodes.some((n) => n.id === current && isSelectable(n))) return current;
  const selectable = nodes.filter(isSelectable);
  if (selectable.length === 1) return selectable[0].id;
  return "";
}

/**
 * Element ids of the form fields, for `htmlFor`/`id` association; they anchor
 * the searchable inputs. Two sets exist and both are e2e-pinned: the default
 * `picker-*` (every launch dialog, including the one `/new` now raises) and
 * the setup assistant's `setup-*`, which is a different form on screen at a
 * different moment rather than a second spelling of this one.
 */
export interface NewSubshellFormIds {
  /** "Copy settings from" combobox input */
  copy: string;
  /** Agent combobox input */
  agent: string;
  /** Preset select trigger */
  preset: string;
  /** Working-directory input */
  workingDir: string;
  /** Node combobox input */
  node: string;
}

/** The `picker-*` set every launch dialog gets by default. */
export const DIALOG_IDS: NewSubshellFormIds = {
  copy: "picker-copy",
  agent: "picker-agent",
  preset: "picker-preset",
  workingDir: "picker-working-dir",
  node: "picker-node",
};
