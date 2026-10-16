import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  errMessage,
  Label,
  type NodeDetail,
  Switch,
} from "@internal/node-admin";
import type { ReactNode } from "react";
import { useSetSshEnabled, useSetSshWideForwards } from "@/hooks/use-ssh";

/** The node's configuration permission is supplied by the same server gate as the update route. */
export function NodeSshCard({ node, children }: { node: NodeDetail; children?: ReactNode }) {
  const update = useSetSshEnabled();
  const wide = useSetSshWideForwards();
  return (
    <Card>
      <CardHeader>
        <CardTitle>SSH</CardTitle>
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
          <p className="text-detail text-muted-foreground">
            {node.sshEnabled
              ? "Turning this off prevents new SSH connections from this node and stops it from providing keys to other nodes. Incoming SSH access to this machine is unaffected."
              : "Turning this on allows SSH connections from this node and lets it provide keys to other nodes through Subshell. It doesn't enable incoming SSH access to this machine."}
          </p>
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
        {node.sshEnabled && (
          <div className="flex flex-col items-start gap-2">
            <div className="flex items-center gap-4">
              <Switch
                id="node-ssh-wide-forwards"
                checked={node.sshWideForwards}
                disabled={!node.canManage || wide.isPending}
                onCheckedChange={(on) => wide.mutate({ id: node.id, on })}
              />
              <Label htmlFor="node-ssh-wide-forwards">Allow wide port forwards</Label>
            </div>
            <p className="text-detail text-muted-foreground">
              {node.sshWideForwards
                ? "Port forwards can bind an address other machines can reach, so this machine routes their traffic into whatever the connection reaches. Turning this off refuses future wide binds; running forwards keep going until their pane closes."
                : "Port forwards here listen on 127.0.0.1 only. Turn this on to let a forward bind another address, such as 0.0.0.0 for every interface."}
            </p>
            {!node.canManage && (
              <p className="text-detail text-warning">Only this node’s owner can change this setting.</p>
            )}
            {wide.isError && (
              <p role="alert" className="text-destructive text-detail">
                {errMessage(wide.error, "Couldn't update the port-forward setting.")}
              </p>
            )}
          </div>
        )}
        {children}
      </CardContent>
    </Card>
  );
}
