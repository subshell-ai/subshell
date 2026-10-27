import { displayProviderRunsOnOs } from "@internal/subshell-protocol";

/**
 * The provider a form may keep after its machine changes.
 *
 * One machine's display provider is another machine's refusal, and both launch
 * surfaces (the form's Machine select, the preset editor's node pick) re-enter
 * the same value through their own handler, so the rule lives here once: a pick
 * the new machine can run survives untouched, a bundled one it cannot is
 * dropped back to the node default, and an id this package does not ship stays
 * because nothing here has a platform fact about it (the node's own readiness
 * answer is what rules those in or out). An unknown OS answers nothing, so it
 * clears nothing either: the node list is often still loading when a form
 * mounts, and a saved provider lost to that read is a worse bug than a stale
 * pick that survives one frame. Dropping rather than disabling is deliberate:
 * a greyed-out provider still launches with it.
 */
export function providerForMachine(provider: string | undefined, os: string | null | undefined): string | undefined {
  // No OS answered yet is not a machine that cannot run the pick: the node list
  // is still loading, no machine is chosen, or the node enrolled and never came
  // ready. Clearing on that reading would cost someone a saved provider on
  // every mount, so the rule waits for a fact.
  if (provider === undefined || os === null || os === undefined) return provider;
  return displayProviderRunsOnOs(provider, os) ? provider : undefined;
}

/**
 * The provider list the same machine may be offered, decided by the same
 * reading as {@link providerForMachine}, because the two have to agree.
 *
 * Filtering on an OS that has not answered while keeping the value (what
 * reading `os: null` as "not Linux" did) left a picker whose trigger said
 * "Node default" over a saved pin of BetterDisplay: the person approved a
 * launch whose provider they were never shown, and the preset kept it. No
 * verdict means no filtering, so what the row offers, what the value may be,
 * and what launches stay one answer. The node's own readiness check stays the
 * authority on what actually runs there.
 */
export function providersForMachine(ids: readonly string[], os: string | null | undefined): string[] {
  if (os === null || os === undefined) return [...ids];
  return ids.filter((id) => displayProviderRunsOnOs(id, os));
}

/**
 * The node's own default, shown only when that same machine could run it: a
 * label naming an impossible provider teaches the reader the label is decorative.
 */
export function nodeDefaultForMachine(
  defaultProvider: string | undefined,
  os: string | null | undefined,
): string | undefined {
  if (defaultProvider === undefined) return undefined;
  return providerForMachine(defaultProvider, os);
}
