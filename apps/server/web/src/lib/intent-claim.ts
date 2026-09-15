import type { SplitIntent } from "@/lib/workspace-split-intent";

/**
 * A one-shot claim over a split intent, shared by the two presentations.
 *
 * The workspace page renders ONE of `WorkspaceDock` / `WorkspaceTabs`,
 * decided by viewport width. Each used to hold its own "already consumed"
 * ref, which is correct for as long as the same one stays mounted — and a
 * viewport crossing the tiling breakpoint mid-add does not: the first
 * presentation unmounts with the add in flight, the second mounts with
 * `?add=` still in the URL and a fresh ref, and the server does not dedupe,
 * so the subshell lands on the workspace twice (regression #13, review
 * 2026-09-14). One claim held ABOVE both is what makes the guard survive the
 * swap.
 *
 * Identity, not value, is what resets it: the route memoizes its intent off
 * the search params, so a new object means a new URL means a new split to
 * act on — and the same object across a hundred poll-driven renders is the
 * one already claimed.
 * @returns A function answering true for the first caller to see each intent
 */
export function createIntentClaim(): (intent: SplitIntent | null) => boolean {
  let claimed: SplitIntent | null = null;
  return (intent) => {
    // A null intent is nothing to claim: answering true for it would spend
    // the claim on the absence of a split, and the real one would then find
    // it already taken.
    if (!intent || claimed === intent) return false;
    claimed = intent;
    return true;
  };
}
