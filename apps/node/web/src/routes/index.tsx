import {
  Badge,
  Fact,
  FactCard,
  NodeLogCard,
  NodeMaintenanceCard,
  NodeRuntimeCard,
  NodeServiceCard,
  relativeElapsed,
  useNode,
} from "@internal/node-admin";
import { NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: StatusPage });

/**
 * Status — the whole machine on one page.
 *
 * The control-plane Nodes page splits these same cards across Overview /
 * Service / Logs because a browser there is one of many viewers and each
 * section is a decision. Here there is one viewer, at the machine, for the
 * machine; the three questions ("is it healthy", "how does it run / restart
 * it", "what did it log") belong together, so the page that answers them does
 * not make you click between tabs. The cards are the shared ones, unmodified —
 * which is the point of the extraction.
 */
function StatusPage() {
  const node = useNode("self");

  if (node.isError) {
    return (
      <p role="alert" className="text-body text-destructive">
        The node did not answer. It may be restarting.
      </p>
    );
  }
  const n = node.data;
  if (!n) {
    return <p className="text-body text-muted-foreground">Loading…</p>;
  }

  return (
    <>
      <FactCard title="This machine">
        <Fact label="Status">
          <Badge variant={n.status === "online" ? "success" : "muted"}>{n.status}</Badge>
        </Fact>
        <Fact label="Node version">
          {n.agentVersion ?? "—"}
          {n.protocolVersion != null && n.protocolVersion !== NODE_PROTOCOL_VERSION && (
            <Badge variant="warning" className="ml-2">
              protocol v{n.protocolVersion}
            </Badge>
          )}
        </Fact>
        <Fact label="OS / arch">
          {n.os ?? "—"}
          {n.arch ? ` · ${n.arch}` : ""}
        </Fact>
        <Fact label="Hostname">{n.hostname ?? "—"}</Fact>
        <Fact label="Control plane" mono>
          {n.serverUrl ?? "—"}
        </Fact>
        {n.runningSubshells != null && <Fact label="Work here">{n.runningSubshells} subshells</Fact>}
        {n.runtime && <Fact label="Running since">{relativeElapsed(n.runtime.startedAt)}</Fact>}
      </FactCard>

      <NodeMaintenanceCard node={n} />

      {n.runtime ? (
        <>
          <NodeRuntimeCard node={n} local />
          <NodeServiceCard node={n} local updateHref="/updates" />
        </>
      ) : (
        <p className="text-body text-muted-foreground">This node did not report how it runs.</p>
      )}

      <NodeLogCard node={n} local />
    </>
  );
}
