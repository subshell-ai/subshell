/**
 * One harness package-manager run at a time on the control-plane host.
 *
 * Harness Install and Update both run a vendor shell line as the server's own
 * OS user against the same filesystem. The harness card disables both
 * directions while either is in flight, but that is a single page's state: two
 * tabs, or the API directly, can ask one while the other is running. The
 * node-side update chain serializes updates among themselves; this is the
 * plane-side half that also covers install, whose own lock is per plugin id
 * and therefore cannot see an update for a different harness.
 *
 * The fixed-argv installers on their own admin routes (tmux, network) remain
 * outside this slot; they are not harness vendor lines and have separate
 * single-flight policy.
 *
 * The holder is a short label ("install \"codex\"") so a refusal can say what
 * the caller is waiting behind.
 */
let holder: string | undefined;

/**
 * Take the host's run slot, or undefined when someone else holds it.
 * @param label - what the caller is about to run, for the refusal message
 * @returns an idempotent release function, or undefined when the slot is taken
 */
export function claimLocalRun(label: string): (() => void) | undefined {
  if (holder !== undefined) return undefined;
  holder = label;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (holder === label) holder = undefined;
  };
}

/** What currently holds the host's run slot, or undefined when it is free. */
export function localRunHolder(): string | undefined {
  return holder;
}

/** Test seam: drop the slot so one suite's refusal cannot leak into the next. */
export function resetLocalRunForTests(): void {
  holder = undefined;
}
