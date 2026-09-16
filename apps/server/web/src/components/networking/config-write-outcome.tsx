import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { NetworkRestartNotice } from "@/components/networking/network-restart-notice";
import type { ServerRestart } from "@/hooks/use-server-restart";
import type { NetworkConfigOutcome } from "@/types/network";

/**
 * The tail every network act leaves in the card's result area: the write's
 * warnings, the key that could not land, and — when the write awaits a
 * restart — the restart itself.
 *
 * Shared by the publish and unpublish results rather than copied, so the
 * restart a removal needs looks and BEHAVES like the one an addition needs:
 * same button, same dialog, same waiter, one spinner.
 *
 * The summary line above it differs per act — publishing announces a
 * publish, unpubishing names what it removed — and belongs to the callers.
 */
export function ConfigWriteOutcome({
  config,
  restartRequired,
  restart,
  removal = false,
  enables,
}: {
  /** What the act's config.env write did */
  config: NetworkConfigOutcome;
  /** Whether the write lands only on the next restart */
  restartRequired: boolean;
  /** The card's one restart waiter, so the acts can be locked while it runs */
  restart: ServerRestart;
  /** True for the acts that TOOK origins away (unpublish, leave) — it selects
   * "apply the change" over the publish's "apply the new address". */
  removal?: boolean;
  /** What the restart turns on, named for the confirm dialog (see there). */
  enables?: ReactNode;
}) {
  return (
    <>
      {config.warnings.map((warning) => (
        <p key={warning} className="text-detail text-warning">
          {warning}
        </p>
      ))}
      {/* The write did not land, and the reason is that the key is
          the environment's — the same "environment wins, and a write
          the next read would mask is not a success" rule the rest of
          the config ladder follows. Naming the key is the whole
          point: it is where the change has to be made instead. */}
      {/* Names the KEY that did not land, never a reason for it and
          never the whole file. `unwritableKey` is set on three
          different paths — the environment owning the key, an
          unreadable config file, a validator refusal — so naming the
          first unconditionally sent an admin to edit a unit file over
          what was really a validation error; the true reason is in
          `config.warnings` just above, in the server's own words.
          And a partial write must not contradict itself: `written`
          is false whenever ANY key was refused, so a frame that both
          changed one key and refused another would otherwise read
          "updated TRUSTED_ORIGINS" and "config.env was not changed"
          four lines apart, about one write. */}
      {!config.written && (
        <p className="text-detail text-warning">
          {config.unwritableKey ? (
            <>
              <span className="font-mono">{config.unwritableKey}</span> was not written to config.env.
            </>
          ) : (
            "config.env was not changed."
          )}
        </p>
      )}
      {restartRequired && <NetworkRestartNotice restart={restart} removal={removal} enables={enables} />}
      {/* The outage the press opened. The acts around this block are already
          disabled — the card folds `waiting` into `busy` — so the spinner is
          not decoration: it is the reason those buttons went quiet. */}
      {restart.outcome === "waiting" && (
        <p aria-live="polite" className="flex items-center gap-1.5 text-detail text-muted-foreground">
          <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
          Restarting the server…
        </p>
      )}
    </>
  );
}
