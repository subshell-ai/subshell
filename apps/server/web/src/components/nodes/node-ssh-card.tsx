import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  errMessage,
  Label,
  type NodeDetail,
  Switch,
} from "@internal/node-admin";
import { useSetSshEnabled } from "@/hooks/use-ssh";

/** The node's configuration permission is supplied by the same server gate as the update route. */
export function NodeSshCard({ node }: { node: NodeDetail }) {
  const update = useSetSshEnabled();
  return (
    <Card>
      <CardHeader>
        <CardTitle>SSH</CardTitle>
        <CardDescription>
          Allow this node to make outgoing SSH connections and supply keys to other nodes through Subshell. This doesn't
          enable incoming SSH access.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <div className="flex items-center gap-4">
          <Switch
            id="node-ssh-enabled"
            checked={node.sshEnabled}
            disabled={!node.canManage || update.isPending}
            onCheckedChange={(on) => update.mutate({ id: node.id, on })}
          />
          <Label htmlFor="node-ssh-enabled">Allow SSH</Label>
        </div>
        {node.canManage ? (
          node.sshEnabled && (
            <p className="text-detail text-muted-foreground">
              Disabling SSH blocks new connections and stops this node from supplying keys to active connections.
            </p>
          )
        ) : (
          <p className="text-detail text-muted-foreground">
            {node.kind === "local"
              ? "An admin can change this setting."
              : "Only this node’s owner can change this setting."}
          </p>
        )}
        {update.isError && (
          <p role="alert" className="text-destructive text-detail">
            {errMessage(update.error, "Couldn't update the SSH setting.")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
