/**
 * Poll `cond` until it is true, throwing after `budgetMs`.
 *
 * Command dispatch through the node link is JWS-signed before it is sent, so
 * "assert the frame landed" cannot be a fixed `setTimeout` peek: under CI load
 * (4-core runner, `--parallel`) the chain is slow-but-fine and a 5 ms nap
 * reads it as nothing-sent - the shape of the 2026-09-30 flake in
 * `held-connections.test.ts`. The budget keeps a real regression red rather
 * than merely late. (Two ws integration suites carried private copies of
 * this; this is the third, extracted at the point the duplication stopped
 * paying rent.)
 */
export async function until(cond: () => boolean, what = "condition", budgetMs = 4000): Promise<void> {
  for (let waited = 0; ; waited += 5) {
    if (cond()) return;
    if (waited > budgetMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
