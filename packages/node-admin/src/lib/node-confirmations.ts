/**
 * Confirmation prompts for the node acts that reach past the person clicking
 * them, sibling to `lib/subshell-confirmations.ts` and following its rule:
 * the TITLE is the question with the node's name in it, the DESCRIPTION is
 * the one-sentence consequence.
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
 * ENDING maintenance is deliberately unasked: it only widens what the machine
 * will accept, and nothing is lost by clicking it (the same reasoning that
 * leaves a subshell restart unconfirmed).
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
  if (runningSubshells === undefined) return "Any subshells running here will be stopped and their owners notified.";
  if (runningSubshells === 0) return "Nothing is running here.";
  // "N subshells", never "N running": the server counts parked rows too, so
  // the stronger word would claim more than the number supports.
  return `${subshellCount(runningSubshells)} running here will be stopped and their owners notified.`;
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
  const description = `${stoppingClause(runningSubshells)} Nobody${
    isLocal ? ", admins included," : ""
  } can launch here until maintenance ends.`;
  return confirmAction({
    title: `Start maintenance on "${name}"?`,
    description,
    confirmLabel: "Start maintenance",
    danger: true,
  });
}
