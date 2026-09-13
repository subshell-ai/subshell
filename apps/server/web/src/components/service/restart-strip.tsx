import { resumeElsewhere } from "@/components/service/restart-dialog";
import type { ServerRestart } from "@/hooks/use-server-restart";
import type { ServerDeployment } from "@/types/server-deployment";

/** The address to point at when this page cannot watch the server return. */
export function ElsewhereLink({ href }: { href: string }) {
  return (
    <>
      {" "}
      The server will come back at{" "}
      <a href={href} target="_blank" rel="noreferrer" className="underline">
        {href}
      </a>
      .
    </>
  );
}

/**
 * What the page says when a restart goes WRONG. Only that.
 *
 * The two states that used to live here have gone, each for its own reason:
 *
 * - **"Restarting…" moved into the supervision line** (`service-card.tsx`).
 *   As a second element it sat directly under "Running under launchd as pid
 *   4242", and the two sentences cannot both be true at once — the page
 *   claimed the old process was up while announcing it had been taken down.
 *   It is the same fact at two moments, so it is now one line.
 * - **"Back." is gone entirely.** When the server returns, the waiter
 *   invalidates both `admin/status` and the deployment view, so the
 *   supervision line re-renders with the NEW pid and a new start time. That
 *   sentence is the confirmation; a banner saying "Back." beside it added a
 *   second thing to read and a dismiss button to press for news the page had
 *   already delivered.
 *
 * Still deliberately quiet about the outage itself: the offline banner owns
 * "Can't reach the subshell server, retrying…" for every outage in the app.
 * What is left here is the part no other surface says — that the restart this
 * person asked for failed, or never landed.
 */
export function RestartStrip({ view, restart }: { view: ServerDeployment; restart: ServerRestart }) {
  const elsewhere = resumeElsewhere(view);

  if (restart.error) {
    return <p className="col-span-full text-destructive text-sm">{restart.error}</p>;
  }
  if (restart.outcome === "timeout") {
    return (
      <p className="col-span-full text-destructive text-sm">
        The server has not come back. Check the service where it runs.
        {elsewhere && <ElsewhereLink href={elsewhere} />}
      </p>
    );
  }
  return null;
}
