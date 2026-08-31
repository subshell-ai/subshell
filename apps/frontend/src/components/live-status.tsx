import type { JSX } from "react";
import { cn } from "@/lib/utils";

/**
 * Whether this page is receiving live session updates.
 *
 * It replaces a bare "live" / "offline" badge, which named the transport
 * rather than saying anything a reader could act on, and sat next to the view
 * toggle looking like a third control. The wording now answers the only
 * question worth asking of it — is what I'm looking at current? — and the
 * healthy state is quiet text rather than a pill competing with the buttons
 * beside it.
 *
 * The disconnected wording is "reconnecting", not "offline", because that is
 * what is actually happening: `useLiveSessions` retries with a fresh token on
 * every drop, and the list still renders from the REST fetch meanwhile. A
 * brief flap during a reconnect therefore reads as a transient state instead
 * of an error.
 */
export function LiveStatus({ connected }: { connected: boolean }): JSX.Element {
  return (
    <span
      className="flex items-center gap-1.5 text-muted-foreground text-xs"
      // aria-live so a screen reader announces a drop, but "polite" so it
      // waits for a pause rather than interrupting.
      aria-live="polite"
      title={
        connected
          ? "This list updates on its own as sessions start, finish and produce output."
          : "Live updates were interrupted and are being retried. What you see may be out of date until they resume."
      }
    >
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", connected ? "bg-success" : "bg-warning")}
      />
      {connected ? "Updating live" : "Reconnecting…"}
    </span>
  );
}
