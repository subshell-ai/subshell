/**
 * What a maintenance flip SAYS after the fact, and the one spelling of a
 * subshell count both surfaces share with `lib/node-confirmations.ts`.
 *
 * The plane answers a flip with `stopped` and — only when the node refused a
 * kill — `failed`. Those refusals are the reason this module exists: the two
 * callers (the card on a node's page, the row on `/nodes`) used to type the
 * response as a plain node view and drop both arrays, so a window where three
 * of five kills were refused rendered exactly like a clean one. The machine is
 * genuinely in maintenance and genuinely launching nothing; what is NOT true
 * is that the person can now touch it, and that is the sentence.
 */

/** `N subshells`, singular at one — the spelling every maintenance surface uses. */
export function subshellCount(n: number): string {
  return `${n} subshell${n === 1 ? "" : "s"}`;
}

/**
 * The line to show after a flip the node only partly applied, or null when it
 * applied cleanly.
 *
 * Both halves are stated because either alone misleads: naming only the
 * refusals reads as "the switch did not work", and naming only the state reads
 * as "everything here is stopped". The count is the point — it is how much
 * work is still alive on a machine somebody is about to open up.
 *
 * @param name - The node's display name
 * @param failed - Subshell ids the node refused to kill; absent or empty = a clean flip
 */
export function maintenanceRefusalNotice(name: string, failed: string[] | undefined): string | null {
  if (failed === undefined || failed.length === 0) return null;
  return `${name} is in maintenance and will launch nothing, but ${subshellCount(failed.length)} could not be stopped and may still be running there.`;
}
