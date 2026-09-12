import { X } from "lucide-react";
import { resumeElsewhere } from "@/components/service/restart-dialog";
import { Button } from "@/components/ui/button";
import type { ServerRestart } from "@/hooks/use-server-restart";
import type { ServerDeployment } from "@/types/server-deployment";

/** The address to point at when this page cannot watch the server return. */
function ElsewhereLink({ href }: { href: string }) {
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
 * What the page says while the server is away, and once it is back.
 *
 * Deliberately quiet about the outage itself: the offline banner already owns
 * "Can't reach the subshell server, retrying…" for every outage in the app,
 * and this strip answers a different question — whether the thing that just
 * happened was the restart this person asked for.
 */
export function RestartStrip({ view, restart }: { view: ServerDeployment; restart: ServerRestart }) {
  const elsewhere = resumeElsewhere(view);

  if (restart.error) {
    return <p className="col-span-full text-destructive text-sm">{restart.error}</p>;
  }
  if (restart.outcome === "waiting") {
    return (
      <p className="col-span-full text-sm text-warning">
        Restarting… waiting for the server to come back.
        {elsewhere && <ElsewhereLink href={elsewhere} />}
      </p>
    );
  }
  if (restart.outcome === "back") {
    return (
      <p className="col-span-full flex items-center gap-2 text-sm text-success">
        Back.
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => restart.reset()}>
          <X />
        </Button>
      </p>
    );
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
