/**
 * Confirmation prompts for the node acts that reach past the person clicking
 * them. Keep the title fixed and identify the node in the description,
 * along with the consequences.
 *
 * Only ONE node act needs asking, and it is asked from two places — the row's
 * overflow menu on `/nodes` and the Maintenance card on a node's page — which
 * is the whole reason this lives beside `confirm` rather than inside either
 * caller. Starting maintenance stops **every** subshell on that machine,
 * including ones this viewer cannot see: any share on a node lets the grantee
 * launch there, and what they launched is private to them (spec 2026-09-14
 * §9). The owner is told a total and nothing more, and their owners learn by
 * push — so the count is the headline, and it is the one number that makes
 * this prompt worth showing at all.
 *
 * The Maintenance card also confirms ending maintenance before allowing new
 * subshells again. The list menu keeps its direct end action.
 */

import { confirmAction } from "./confirm";
import { subshellCount } from "./node-maintenance";

/**
 * The stopping clause, whose three shapes are three different facts.
 *
 * `undefined` is not a zero and must never render as one: it means the
 * viewer's count never answered — the list payload carries no count at all
 * (`runningSubshells` rides the DETAIL view, manager-only), so a row acting
 * before its detail read lands genuinely does not know. Printing "Nothing is
 * running here" there would promise the one thing this prompt exists to warn
 * about.
 */
function stoppingClause(runningSubshells: number | undefined): string {
  if (runningSubshells === undefined)
    return "Subshell will try to stop any subshells running here and notify their owners.";
  if (runningSubshells === 0) return "Nothing is running here.";
  // "N subshells", never "N running": the server counts parked rows too, so
  // the stronger word would claim more than the number supports.
  return `Subshell will try to stop ${subshellCount(runningSubshells)} here and notify their owners.`;
}

/**
 * Confirmation prompt before putting a node into maintenance.
 * @param node.name - The node's display name (admin-chosen for the host)
 * @param node.isLocal - The control-plane host, which needs the one extra
 *                       clause: an admin's instance-wide edit does not exempt
 *                       them, so the switch they are throwing also locks them
 *                       out until they end it.
 * @param node.runningSubshells - Subshells the flip would stop, or undefined
 *                                when the count is not known here
 * @returns True if the user confirmed
 */
export function confirmStartMaintenance({
  name,
  isLocal,
  runningSubshells,
}: {
  name: string;
  isLocal: boolean;
  runningSubshells: number | undefined;
}): Promise<boolean> {
  const stoppingLimits =
    runningSubshells === 0
      ? ""
      : " Some may keep running if they can't be stopped. Subshells that stop won't restart automatically when maintenance ends.";
  const description = `${stoppingClause(runningSubshells)}${stoppingLimits} Nobody${
    isLocal ? ", admins included," : ""
  } can launch here until maintenance ends.`;
  return confirmAction({
    title: "Start maintenance?",
    description: `On "${name}": ${description}`,
    confirmLabel: "Start maintenance",
    danger: true,
  });
}
