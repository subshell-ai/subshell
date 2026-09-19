import { Loader2 } from "lucide-react";

/**
 * The full-surface screen shown while the node is unreachable.
 *
 * Raised on "the probe can't reach the daemon" — which is right for a
 * restart/update (the daemon comes back and {@link useReconnect} reloads), but
 * NOT necessarily what just happened: `stop` and `uninstall` are one-way from a
 * page the daemon serves, so after those the machine does not answer and never
 * will until someone acts on it. The copy therefore states neither outcome as
 * fact — it says the node is not answering and what that can mean — and it
 * offers a Reload, so the operator is never trapped behind a wall that promises
 * a return the verb they pressed will not cause.
 */
export function ReconnectOverlay(): React.ReactNode {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm">
      <div className="max-w-sm space-y-3 text-center">
        <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" aria-hidden />
        <p className="font-strong text-foreground text-label">The node is not responding</p>
        <p className="text-detail text-muted-foreground">
          Waiting for it to come back. This page reloads itself the moment the node answers.
        </p>
        <p className="text-detail text-muted-foreground">
          If you stopped or uninstalled the service, it will not come back on its own — start it again from a shell on
          this machine.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="text-detail text-primary underline underline-offset-2"
        >
          Reload now
        </button>
      </div>
    </div>
  );
}
