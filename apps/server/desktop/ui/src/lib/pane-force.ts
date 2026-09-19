/**
 * The one refusal a person may overrule, wherever this app restarts a server.
 *
 * Two screens restart: the update act (spec 2026-09-18 § 13.2) and Server
 * Addresses (§ 14.2), and the pane-safety refusal is the same refusal on both
 * — the installed service definition takes live panes down with the process.
 * It lives here rather than on whichever screen wrote it first because the two
 * must not phrase one consequence differently: a person who read the amber
 * sentence on one screen and met a different one on the other would have to
 * work out whether they were being told about two different costs.
 *
 * Pure, so the sentence and the condition are testable without a webview —
 * which in this app is not a preference but the only option: `ui/src/__tests__`
 * has no DOM harness.
 */
import type { Probe } from "./ipc";
import { paneRisk } from "./recovery-model";

/** The amber sentence: what this restart costs on this machine. */
export const PANE_WARNING =
  "The installed service definition does not spare live panes, so this restart closes every subshell running here.";

/** The box's own label: what ticking it permits. */
export const PANE_FORCE_LABEL = "Restart anyway, closing every subshell running on this machine";

/**
 * The Force box, as one screen renders it.
 *
 * Unticked by default wherever a screen has no prior consent to carry: an
 * override that arrives pre-accepted is not an override, and the press without
 * it still lets the CLI refuse the restart — which leaves the machine exactly
 * as it was.
 */
export interface PaneForce {
  checked: boolean;
  /** The amber sentence: what this restart costs on this machine. */
  warning: string;
  /** The box's own label: what ticking it permits. */
  label: string;
}

/**
 * The Force box, where there is a refusal for it to overrule.
 *
 * `restarts` is the whole gate besides the machine's own definition: the box
 * exists to permit a restart, so an act that restarts nothing must not show
 * one. Fail-closed comes from {@link paneRisk}, which counts an unreadable
 * definition as risk.
 */
export function paneForceBox(probe: Probe | null, restarts: boolean, checked: boolean): PaneForce | null {
  if (!restarts || !paneRisk(probe)) return null;
  return { checked, warning: PANE_WARNING, label: PANE_FORCE_LABEL };
}
