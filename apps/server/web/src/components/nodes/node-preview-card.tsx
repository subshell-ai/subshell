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
import { useSetPreviewEnabled } from "@/hooks/use-nodes";

/**
 * The node page's Preview switch, cloned from the SSH card's gate posture:
 * the same owner-only flip (`canManage`, seeded-`local` aside), the same
 * remedy lines for a non-owner, and the one `PUT /:id/preview-enabled` call.
 * The flag is the plane's record, so the switch works on an offline node too
 * - the machine learns the value at its next connect - and the copy says what
 * turning it on lets happen, not that it happens now.
 */
export function NodePreviewCard({ node }: { node: NodeDetail }) {
  const update = useSetPreviewEnabled();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <div className="flex items-center gap-4">
          <Switch
            id="node-preview-enabled"
            checked={node.previewEnabled === true}
            disabled={!node.canManage || update.isPending}
            onCheckedChange={(on) => update.mutate({ id: node.id, on })}
          />
          <Label htmlFor="node-preview-enabled">Allow preview</Label>
        </div>
        {node.canManage ? (
          <p className="text-detail text-muted-foreground">
            {node.previewEnabled
              ? "Pane content on this machine can be watched: forwarded ports, live browser frames, and virtual screens. Turning this off stops new previews; the machine keeps running its panes."
              : "Turning this on lets authorized viewers watch pane content on this machine: forwarded ports, live browser frames, and virtual screens. Every act still goes through the pane's own access rules."}
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
            {errMessage(update.error, "Couldn't update the preview setting.")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
