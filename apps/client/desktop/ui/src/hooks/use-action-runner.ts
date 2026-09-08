/**
 * The one place an action runs: a single `useMutation` every action goes
 * through, which is what makes them serialize.
 *
 * This replaces the vanilla page's hand-rolled `guard()`, and keeps its three
 * hard-won properties:
 *
 * 1. **A failure message always reaches the screen.** The bug that was fixed
 *    two commits before this rewrite: the old code re-probed after an action
 *    and clobbered the message the action had set. Here the message is DERIVED
 *    from the mutation and the probe is a separate query, so a refetch cannot
 *    reach it — the two states are no longer the same variable.
 * 2. **Actions serialize.** `mutate` is refused while one is pending, and the
 *    screens disable themselves off {@link ActionRunner.busy}.
 * 3. **After every action, re-probe** — in `onSettled`, awaited, so `busy`
 *    stays true until the fresh facts have landed. A button that came back
 *    alive before the re-probe would be a button acting on a machine that has
 *    moved on.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type ActionOutcome, type ActionRun, errorText, type PendingConfirmation } from "@/lib/actions";
import type { ActionResult, Probe } from "@/lib/ipc";
import { PROBE_KEY, SETTINGS_KEY } from "./use-node-state";

/** How long to wait for the daemon to take the lock after the manager returns. */
export const SETTLE_DELAY_MS = 1_500;

/**
 * How many extra probes a settle is allowed. A settle, never a poll: each one
 * is two CLI spawns.
 */
export const SETTLE_ATTEMPTS = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One submission to the runner. */
interface ActionSpec {
  run: ActionRun;
  /**
   * Whether to re-read the probe afterwards. False for the tray switch only:
   * it changes nothing the probe reports, and a checkbox is not worth two CLI
   * spawns.
   */
  reprobe: boolean;
}

export interface ActionRunner {
  /** True while an action is in flight, including its re-probe. */
  busy: boolean;
  /** The CLI's own words from the last action, or null. */
  output: ActionResult | null;
  /** Why the last action failed, in the CLI's (or Rust's) words. "" when it did not. */
  failure: string;
  /** The confirmation awaiting an answer, or null. */
  pending: PendingConfirmation | null;
  /** Submit an action. Ignored while one is already running. */
  run: (body: ActionRun, opts?: { reprobe?: boolean }) => void;
  /** Run {@link ActionRunner.pending}'s action. */
  accept: () => void;
  /** Dismiss the confirmation, leaving whatever output it was raised over. */
  cancel: () => void;
  /**
   * Wait for the daemon to take the lock after `service start`/`restart`
   * returns. Called from inside an action body.
   */
  settle: () => Promise<void>;
}

export function useActionRunner(): ActionRunner {
  const queryClient = useQueryClient();
  /**
   * Whether the user dismissed the confirmation the current outcome carries.
   *
   * A flag rather than `mutation.reset()`, because resetting would also drop
   * the OUTPUT the confirmation was raised over — and for a refused restart
   * that output is the CLI's verbatim refusal, which is the most useful thing
   * on the screen.
   */
  const [confirmDismissed, setConfirmDismissed] = useState(false);

  const mutation = useMutation<ActionOutcome, unknown, ActionSpec>({
    mutationFn: (spec) => spec.run(),
    // NEVER retry. A setup key is single-use, and an enroll that reached the
    // control plane has spent it whatever it answered; a second attempt with
    // the same key cannot succeed. `service restart` is not idempotent either.
    // This is TanStack's default for mutations and is pinned here on purpose.
    retry: false,
    onMutate: () => {
      setConfirmDismissed(false);
    },
    onSettled: async (_data, _error, spec) => {
      // Awaited, so `busy` covers the re-probe too — see the note above.
      if (spec.reprobe) await queryClient.refetchQueries({ queryKey: PROBE_KEY });
      await queryClient.refetchQueries({ queryKey: SETTINGS_KEY });
    },
  });

  const busy = mutation.isPending;
  const outcome = mutation.data;
  const output = outcome?.output ?? null;
  const pending = confirmDismissed ? null : (outcome?.confirm ?? null);

  const failure =
    mutation.status === "error"
      ? errorText(mutation.error)
      : // A refusal that raised its own confirmation is explained by that
        // panel; saying "that did not work" over the top of it reads as a dead
        // end. Read off the raw outcome, not the dismissed view, so cancelling
        // a confirmation does not conjure this line.
        outcome && outcome.output?.ok === false && outcome.confirm === null
        ? "That did not work — see the output below."
        : "";

  function run(body: ActionRun, opts?: { reprobe?: boolean }): void {
    if (mutation.isPending) return;
    mutation.mutate({ run: body, reprobe: opts?.reprobe ?? true });
  }

  function accept(): void {
    // Captured before `mutate`, which clears `mutation.data` and with it the
    // confirmation this was read from.
    const confirmed = pending;
    if (confirmed === null || mutation.isPending) return;
    mutation.mutate({ run: confirmed.run, reprobe: true });
  }

  function cancel(): void {
    if (mutation.isPending) return;
    setConfirmDismissed(true);
  }

  /**
   * `service start` returns as soon as systemd/launchd has spawned the
   * process; the daemon writes `daemon.lock` a beat later. Without this,
   * starting a stopped node lands on "Offline" — which looks like a failure
   * and invites a restart that was never needed.
   */
  async function settle(): Promise<void> {
    for (let i = 0; i < SETTLE_ATTEMPTS; i += 1) {
      if (queryClient.getQueryData<Probe>(PROBE_KEY)?.step === "online") return;
      await sleep(SETTLE_DELAY_MS);
      await queryClient.refetchQueries({ queryKey: PROBE_KEY });
    }
  }

  return { busy, output, failure, pending, run, accept, cancel, settle };
}
