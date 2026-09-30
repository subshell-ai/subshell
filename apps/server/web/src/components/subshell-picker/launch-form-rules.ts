import type { Node } from "@internal/node-admin";
import { isOfflineAgent } from "@/lib/node-label";
import type { PromptBlock } from "@/lib/prompt-stack";
import { launchableNodes } from "@/lib/subshell-compat";

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
  /**
   * The prompt stack, in the order it will be typed (spec 2026-09-28,
   * checkbox retired 2026-09-30: the blocks ARE the switch). Empty, the
   * create body carries no `prompt` field. Always starts empty; a clone
   * copies settings, not prompts.
   */
  promptBlocks: PromptBlock[];
  /**
   * "Save as preset" (operator ruling 2026-09-30, replacing the picker's
   * `+`): on submit the launch ALSO creates a new preset from the agent,
   * machine, directory and prompts as filled here. Optional on the type -
   * an absent value is the untouched false; no existing caller literal
   * changes. Nothing about the launch differs; the preset is the extra
   * artifact the check promises.
   */
  saveAsPreset?: boolean;
  /** The new preset's name; REQUIRED (trimmed) while `saveAsPreset` is checked. */
  presetName?: string;
}

export function emptyNewSubshellForm(): NewSubshellFormValue {
  return { harnessId: "", presetId: null, workingDir: "", nodeId: "local", promptBlocks: [] };
}

/** True once the form has everything the create call requires. */
export function canSubmit(value: NewSubshellFormValue): boolean {
  // A checked "Save as preset" without a name is an unnamed promise; the
  // field is required exactly while the box is checked (ruling 2026-09-30).
  const presetNamed = value.saveAsPreset !== true || (value.presetName ?? "").trim() !== "";
  return Boolean(value.harnessId) && Boolean(value.workingDir.trim()) && Boolean(value.nodeId) && presetNamed;
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
  /** Agent combobox input */
  agent: string;
  /** Preset select trigger */
  preset: string;
  /** Working-directory input */
  workingDir: string;
  /** Node combobox input */
  node: string;
  /** Add-prompt button of the shared prompt section */
  prompt: string;
  /** "Save as preset" checkbox */
  savePreset: string;
  /** New-preset name input, shown while the box is checked */
  presetName: string;
}

/** The `picker-*` set every launch dialog gets by default. */
export const DIALOG_IDS: NewSubshellFormIds = {
  agent: "picker-agent",
  preset: "picker-preset",
  workingDir: "picker-working-dir",
  node: "picker-node",
  prompt: "picker-prompt-add",
  savePreset: "picker-save-as-preset",
  presetName: "picker-preset-name",
};
