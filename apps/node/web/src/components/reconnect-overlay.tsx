import { Loader2 } from "lucide-react";

/**
 * The full-surface screen shown while the node is unreachable.
 *
 * Raising it is honest rather than alarming: on this surface the operator has
 * very likely just caused the outage (Restart, an update, a service stop), and
 * the daemon that would answer is the one coming back. The copy says so and
 * promises to reload itself, because {@link useReconnect} invalidates every
 * query the instant the machine answers — there is nothing to press.
 */
export function ReconnectOverlay(): React.ReactNode {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm">
      <div className="max-w-sm space-y-3 text-center">
        <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" aria-hidden />
        <p className="font-strong text-foreground text-label">The node is restarting</p>
        <p className="text-detail text-muted-foreground">
          Waiting for it to come back. This page reloads itself the moment the node answers.
        </p>
      </div>
    </div>
  );
}
