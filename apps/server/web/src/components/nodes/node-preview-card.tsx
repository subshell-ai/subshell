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
import { useSetViewsEnabled } from "@/hooks/use-nodes";
import { NodeViewReadiness } from "./node-view-readiness";

/**
 * The node page's Preview switch, cloned from the SSH card's gate posture:
 * the same owner-only flip (`canManage`, seeded-`local` aside), the same
 * remedy lines for a non-owner, and the one `PUT /:id/views-enabled` call.
 * The flag is the plane's record, so the switch works on an offline node too
 * - the machine learns the value at its next connect - and the copy says what
 * turning it on lets happen, not that it happens now.
 */
export function NodePreviewCard({ node }: { node: NodeDetail }) {
  const update = useSetViewsEnabled();
  const disabledReason = !node.canManage
    ? node.kind === "local"
      ? "An admin can change this setting."
      : "Only this node’s owner can change this setting."
    : update.isPending
      ? "Saving the apps and screens setting…"
      : undefined;
  const toggle = (
    <Switch
      id="node-preview-enabled"
      checked={node.viewsEnabled === true}
      disabled={Boolean(disabledReason)}
      aria-describedby={disabledReason ? "node-views-disabled-reason" : undefined}
      onCheckedChange={(on) => update.mutate({ id: node.id, on })}
    />
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Apps &amp; screens</CardTitle>
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
          <Label htmlFor="node-preview-enabled">Allow apps and screens</Label>
        </div>
        {node.canManage ? (
          <p className="text-detail text-muted-foreground">
            {node.viewsEnabled
              ? "Authorized viewers can open apps, watch browsers, and control virtual displays on this machine. Turning this off prevents new connections; existing connections and subshells keep running."
              : "Turning this on lets authorized viewers open apps, watch browsers, and control virtual displays. Each subshell’s access rules still apply."}
          </p>
        ) : (
          <p id="node-views-disabled-reason" className="text-detail text-warning">
            {disabledReason}
          </p>
        )}
        <NodeViewReadiness node={node} />
        {node.canManage && update.isPending && (
          <p id="node-views-disabled-reason" role="status" className="text-detail text-muted-foreground">
            {disabledReason}
          </p>
        )}
        {update.isError && (
          <p role="alert" className="text-destructive text-detail">
            {errMessage(update.error, "Couldn't update the apps and screens setting.")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
