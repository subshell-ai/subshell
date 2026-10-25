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
 * The node page's independent preview switches, cloned from the SSH card's gate posture:
 * the same owner-only flip (`canManage`, seeded-`local` aside), the same
 * remedy lines for a non-owner, and the one `PUT /:id/views-enabled` call.
 * The flags are the plane's record, so the switches work on an offline node too
 * - the machine learns the value at its next connect - and the copy says what
 * turning it on lets happen, not that it happens now.
 */
export function NodePreviewCard({ node }: { node: NodeDetail }) {
  return (
    <>
      <NodePreviewFeatureCard node={node} feature="apps" />
      <NodePreviewFeatureCard node={node} feature="display" />
    </>
  );
}

function NodePreviewFeatureCard({ node, feature }: { node: NodeDetail; feature: "apps" | "display" }) {
  const display = feature === "display";
  const enabled = display ? node.virtualDisplayEnabled === true : node.viewsEnabled === true;
  const title = display ? "Virtual displays" : "Apps and browsers";
  const id = display ? "node-virtual-display-enabled" : "node-preview-enabled";
  const reasonId = `${id}-reason`;
  const update = useSetViewsEnabled();
  const disabledReason = !node.canManage
    ? node.kind === "local"
      ? "An admin can change this setting."
      : "Only this node’s owner can change this setting."
    : update.isPending
      ? `Saving ${title.toLowerCase()}…`
      : undefined;
  const toggle = (
    <Switch
      id={id}
      checked={enabled}
      disabled={Boolean(disabledReason)}
      aria-describedby={disabledReason ? reasonId : undefined}
      onCheckedChange={(on) => update.mutate({ id: node.id, on, feature })}
    />
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
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
          <Label htmlFor={id}>{display ? "Allow virtual displays" : "Allow apps and browsers"}</Label>
        </div>
        {node.canManage ? (
          <p className="text-detail text-muted-foreground">
            {display
              ? "Allow subshells to run graphical apps on a machine without a monitor. Choose Virtual display when starting a subshell to create one; enabling this setting alone starts nothing."
              : "Authorized viewers can open web apps and saved services, and watch browsers in any subshell on this node. No per-subshell switch or virtual display is required. Turning this off prevents new connections; existing connections and subshells keep running."}
          </p>
        ) : (
          <p id={reasonId} className="text-detail text-warning">
            {disabledReason}
          </p>
        )}
        {display ? (
          <>
            <p className="text-detail text-warning">
              Each virtual display uses extra memory and CPU. Web app previews don’t need one.
            </p>
            <NodeViewReadiness node={node} />
          </>
        ) : (
          <p className="text-detail text-muted-foreground">
            {!enabled
              ? "Apps and browsers are disabled on this node."
              : node.os !== "linux"
                ? "Automatic app discovery and browser watching require Linux. You can still add HTTP and HTTPS services by port."
                : "Apps and browser features are available to all subshells on this node."}
          </p>
        )}
        {node.canManage && update.isPending && (
          <p id={reasonId} role="status" className="text-detail text-muted-foreground">
            {disabledReason}
          </p>
        )}
        {update.isError && (
          <p role="alert" className="text-destructive text-detail">
            {errMessage(update.error, `Couldn’t update ${title.toLowerCase()}.`)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
