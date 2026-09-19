import { Badge, Fact, FactCard } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import type { AdminStatus } from "@/hooks/use-admin-status";

/**
 * What this control plane is and what it will talk to.
 *
 * The three numbers are not interchangeable and the labels say so: the server
 * version is what YOU deployed, the node protocol is matched EXACTLY (a node
 * ahead of the server is refused just as one behind it is), and the minimum
 * node version is a floor checked before the protocol backstop.
 */
export function VersionsCard({ status }: { status: AdminStatus }) {
  const outdated = status.inventory.nodes.needingUpdate;
  return (
    <FactCard title="Versions">
      <Fact label="Server" mono>
        {status.versions.server}
      </Fact>
      <Fact label="Bun runtime" mono>
        {status.versions.bun}
      </Fact>
      <Fact label="Node protocol" mono>
        v{status.versions.nodeProtocol}
      </Fact>
      <Fact label="Minimum node version" mono>
        {status.versions.minNode}
      </Fact>
      <Fact label="Nodes needing update" wide>
        {outdated.length === 0 ? (
          <span className="text-muted-foreground">
            None. Every enrolled node meets the {status.versions.minNode} floor
          </span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {/* A refused node shows up everywhere else as a plain offline
                node, with nothing saying why. This is the only place that
                explains it, so each one links to the node it names. */}
            {outdated.map((node) => (
              <Link key={node.id} to="/nodes/$id" params={{ id: node.id }}>
                <Badge variant="warning" title={`Refused at connect: needs ${status.versions.minNode} or newer`}>
                  {node.name} · {node.agentVersion ?? "unversioned"}
                </Badge>
              </Link>
            ))}
          </div>
        )}
      </Fact>
    </FactCard>
  );
}
