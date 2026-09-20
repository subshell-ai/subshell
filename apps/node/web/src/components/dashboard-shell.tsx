import { useNode } from "@internal/node-admin";
import { Link, Outlet } from "@tanstack/react-router";
import { ReconnectOverlay } from "@/components/reconnect-overlay";
import { useReconnect } from "@/lib/use-reconnect";

/** The three sections, in the order an operator reads them. */
const NAV = [
  { to: "/", label: "Status" },
  { to: "/settings", label: "Settings" },
  { to: "/updates", label: "Updates" },
] as const;

/**
 * The dashboard's one frame: a slim top bar naming the machine, the three
 * sections, and the page. Everything the daemon answers is under this.
 *
 * No sidebar, no drawer: this is three pages on one loopback machine, not the
 * control plane's multi-resource app. The top bar reads the node name and
 * version from the SAME `useNode("self")` the pages use (one query key, so
 * this costs no extra request) — it exists so the operator is never unsure
 * which machine a page is describing, the one thing a no-login local surface
 * cannot get wrong.
 *
 * The dot is the REACHABILITY probe, not the node's self-reported `status`
 * (which is always "online" here — this process answering IS the status). It
 * goes amber on the outage every act here can cause, in lockstep with the
 * reconnect overlay {@link useReconnect} raises.
 */
export function DashboardShell(): React.ReactNode {
  const down = useReconnect();
  const node = useNode("self");

  return (
    <div className="min-h-full">
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden className={`size-2 shrink-0 rounded-full ${down ? "bg-warning" : "bg-success"}`} />
            <span className="truncate font-strong text-foreground text-label">
              {node.data?.name ?? "Subshell node"}
            </span>
            {node.data?.agentVersion && (
              <span className="shrink-0 text-detail text-muted-foreground">v{node.data.agentVersion}</span>
            )}
            <span className="shrink-0 text-detail text-muted-foreground">· this machine</span>
          </div>
          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="rounded-md px-3 py-1.5 text-body text-muted-foreground hover:text-foreground"
                activeProps={{ className: "bg-accent text-accent-foreground text-body" }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl space-y-6 px-6 py-6">
        <Outlet />
      </main>

      {down && <ReconnectOverlay />}
    </div>
  );
}
