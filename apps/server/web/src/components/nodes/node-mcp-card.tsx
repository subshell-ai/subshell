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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSetMcpEnabled } from "@/hooks/use-nodes";

/**
 * The node's own MCP-use switch. Off here outranks every account preference:
 * the machine's owner is saying nothing of that tool surface runs here, and
 * the node enforces that on itself. The mirror is absent-tolerant in the
 * client the same way it is on the machine: `undefined` means a payload cached
 * before the switch existed, and that read is ALLOWED, not refused.
 *
 * A disabled switch explains itself the way the preview card beside it does:
 * one reason string feeding the tooltip, the focusable wrapper, and the gold
 * line under the control, so a keyboard user tabbing past a locked switch
 * still learns who holds the change.
 */
export function NodeMcpCard({ node }: { node: NodeDetail }) {
  const update = useSetMcpEnabled();
  const allowed = node.mcpEnabled !== false;
  const reasonId = "node-mcp-enabled-reason";
  const disabledReason = !node.canManage
    ? node.kind === "local"
      ? "An admin can change this setting."
      : "Only this node’s owner can change this setting."
    : update.isPending
      ? "Saving the subshell MCP…"
      : undefined;
  const toggle = (
    <Switch
      id="node-mcp-enabled"
      checked={allowed}
      disabled={Boolean(disabledReason)}
      aria-describedby={disabledReason ? reasonId : undefined}
      onCheckedChange={(on) => update.mutate({ id: node.id, on })}
    />
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Subshell MCP</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <div className="flex items-center gap-4">
          {disabledReason ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  // biome-ignore lint/a11y/useSemanticElements: a native button cannot wrap a switch; this focus target explains the disabled control.
                  <span
                    role="button"
                    tabIndex={0}
                    aria-disabled={true}
                    aria-label={disabledReason}
                    className="inline-flex"
                  />
                }
              >
                {toggle}
              </TooltipTrigger>
              <TooltipContent>{disabledReason}</TooltipContent>
            </Tooltip>
          ) : (
            toggle
          )}
          <Label htmlFor="node-mcp-enabled">Allow the subshell MCP</Label>
        </div>
        {node.canManage ? (
          <p className="text-detail text-muted-foreground">
            {allowed
              ? "Turning this off means panes started or restarted here get no subshell MCP and no sibling-coordination tools, whatever their owners prefer. Panes already running keep their live MCP until they restart."
              : "Turning this on wires new launches here with the subshell MCP, unless the pane's owner has switched it off in their preferences. New launches and restarts pick up the change."}
          </p>
        ) : (
          <p id={reasonId} className="text-detail text-warning">
            {disabledReason}
          </p>
        )}
        {update.isError && (
          <p role="alert" className="text-destructive text-detail">
            {errMessage(update.error, "Couldn't update the MCP setting.")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
