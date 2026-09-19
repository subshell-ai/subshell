import { Fact, FactCard } from "@internal/node-admin";
import type { AdminStatus } from "@/hooks/use-admin-status";

/**
 * What lives on this instance, counted server-side across every user.
 *
 * These are deliberately INSTANCE-wide, not viewer-scoped: an admin asking
 * "how big is this thing" wants the real number, and computing it in the
 * browser from list endpoints would have silently answered "what you can see"
 * instead.
 */
export function InventoryCard({ status }: { status: AdminStatus }) {
  const { inventory } = status;
  return (
    <FactCard title="Inventory">
      <Fact label="Users">
        {inventory.users.total}
        <span className="text-muted-foreground"> · {inventory.users.admins} admin</span>
      </Fact>
      <Fact label="Subshells">
        {inventory.subshells.running} running
        <span className="text-muted-foreground"> · {inventory.subshells.total} total</span>
      </Fact>
      <Fact label="Nodes">
        {inventory.nodes.online} online
        <span className="text-muted-foreground"> · {inventory.nodes.total} enrolled</span>
      </Fact>
      <Fact label="Workspaces">{inventory.workspaces}</Fact>
      <Fact label="Presets">{inventory.presets}</Fact>
      <Fact label="Channels">{inventory.channels}</Fact>
    </FactCard>
  );
}
