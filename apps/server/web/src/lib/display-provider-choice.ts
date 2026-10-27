import {
  type DisplayProviderCatalogEntry,
  displayProviderRunsOnOs,
  displayProvidersForOs,
} from "@internal/subshell-protocol";

/**
 * The provider a form may keep after its machine changes.
 *
 * One machine's display provider is another machine's refusal, and both launch
 * surfaces (the form's Machine select, the preset editor's node pick) re-enter
 * the same value through their own handler, so the rule lives here once: a pick
 * the new machine can run survives untouched, a bundled one it cannot is
 * dropped back to the node default, and an id this package does not ship stays
 * because nothing here has a platform fact about it (the node's own readiness
 * answer is what rules those in or out). An OS that has not answered clears
 * nothing either (`displayOsAnswered` decides what counts as an answer, in one
 * place, because the launch forms, the node card and the plane all have to read
 * the same value the same way): the node list is often still loading when a form
 * mounts, and a saved provider lost to that read is a worse bug than a stale
 * pick that survives one frame. Dropping rather than disabling is deliberate:
 * a greyed-out provider still launches with it.
 */
export function providerForMachine(provider: string | undefined, os: string | null | undefined): string | undefined {
  // No OS answered yet is not a machine that cannot run the pick: the node list
  // is still loading, no machine is chosen, or the node enrolled and never came
  // ready. Clearing on that reading would cost someone a saved provider on
  // every mount, so the rule waits for a fact.
  if (provider === undefined) return provider;
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
  return ids.filter((id) => displayProviderRunsOnOs(id, os));
}

/**
 * The provider rows a launch offers on one node, with the held pick kept legible.
 *
 * A node's stored list is the owner's enable choice, so a preset pinning
 * BetterDisplay on a Mac that has only Xvfb enabled is a launch the plane
 * refuses ("disabled on the node… choose another provider"). The gold line that
 * says so sits beside a trigger reading "Node default": the person is told to
 * change a choice the page will not name or show, and cannot pick their way out
 * because "Node default" is already what the trigger says. So a held id this
 * machine's OS could run stays on the list, and what stays off it is the one the
 * OS gate removed, which the caller's own clearing rule already drops. The
 * preset editor does not need this: it offers the whole catalog for the machine,
 * because a preset is written before anyone knows which node will run it.
 */
export function offeredDisplayProviders(
  ids: readonly string[],
  os: string | null | undefined,
  held: string | undefined,
): string[] {
  const offered = providersForMachine(ids, os);
  if (held === undefined || offered.includes(held)) return offered;
  return providerForMachine(held, os) === held ? [...offered, held] : offered;
}

/**
 * The bundled catalog a machine may be offered, by the same reading as above.
 *
 * The node settings card and the launch surfaces ask the same question with
 * different data (catalog entries to render, ids to list), so they share this
 * one. An unanswered OS answers nothing: an enrolled node that never came ready
 * keeps its full catalog here rather than being told no provider supports an
 * operating system it has not reported, which is the reading that would strand
 * the owner's only path to pre-enable a provider.
 */
export function bundledProvidersForMachine(os: string | null | undefined): readonly DisplayProviderCatalogEntry[] {
  return displayProvidersForOs(os);
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
