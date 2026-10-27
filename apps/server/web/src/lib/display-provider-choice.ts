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
  // is still loading, or no machine is chosen. Clearing on that reading would
  // cost someone a saved provider on every mount, so the rule waits for a fact.
  if (provider === undefined || os === null || os === undefined) return provider;
  return displayProviderRunsOnOs(provider, os) ? provider : undefined;
}
