/**
 * The assistant poll's redraw decision, pure.
 *
 * The 1500 ms poll used to rebuild the whole screen unconditionally, which ate
 * real clicks: a rebuild landing between mousedown and mouseup detaches the
 * pressed button, and the composed click fires on an ancestor no listener is
 * bound to (reported on the recovery screen, 2026-09-21). So the poll renders
 * only when what it can change has changed — but a bare before/after
 * comparison has a blind spot this function exists to name.
 *
 * `before === after` alone does NOT license skipping when the poll has SKIPPED
 * a tick since its last render. State mutated during a skip window (`tick`'s
 * typing guard, `busy`, a hidden window) is invisible to snapshots taken on
 * either side of the change, because both read AFTER the mutation landed. The
 * port-conflict answer is the case in point: `checkPort` resolves while the
 * port field is focused, caches its answer, and renders only when no text
 * field has focus, so the answer sits cached and unseen, the typed port's
 * warning never appears, and the `canSetup`-gated button keeps its stale
 * reason until some other state moves (review, 2026-09-21).
 *
 * `catchUp` is that memory: true on the first tick that executes after any
 * skipped one, and it forces the render regardless of the comparison.
 */
export function pollShouldRender(before: string, after: string, catchUp: boolean): boolean {
  return catchUp || before !== after;
}
