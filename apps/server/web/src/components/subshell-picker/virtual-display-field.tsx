import { Button, Label, type Node } from "@internal/node-admin";
import { DEFAULT_VIRTUAL_DISPLAY_PROVIDER } from "@internal/subshell-protocol";
import { Link } from "@tanstack/react-router";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNodeDisplayReadiness } from "@/hooks/use-node-display-readiness";
import { DisplayProviderPicker } from "./display-provider-picker";

export function VirtualDisplayField({
  node,
  id,
  checked,
  onChange,
  onLeave,
  provider,
  onProviderChange,
}: {
  node: Node | null;
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  onLeave?: () => void;
  provider?: string;
  onProviderChange?: (provider: string | undefined) => void;
}) {
  const { check, reason, needsSetup, shouldCheck } = useNodeDisplayReadiness(node, provider);
  const providers = node?.virtualDisplayProviders ?? [DEFAULT_VIRTUAL_DISPLAY_PROVIDER];
  const control = (
    <div className="flex items-center gap-3">
      <Checkbox
        id={id}
        checked={checked}
        disabled={Boolean(reason) && !checked}
        onCheckedChange={onChange}
        aria-describedby={reason ? `${id}-hint ${id}-cost ${id}-reason` : `${id}-hint ${id}-cost`}
      />
      <Label htmlFor={id}>Virtual display</Label>
    </div>
  );
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      {reason ? (
        <Tooltip>
          <TooltipTrigger
            render={
              // biome-ignore lint/a11y/useSemanticElements: a native button cannot contain the checkbox; this focusable wrapper explains why it is disabled.
              <span
                role="button"
                aria-disabled={true}
                tabIndex={0}
                className="inline-flex"
                aria-label={`Virtual display unavailable. ${reason}`}
              />
            }
          >
            {control}
          </TooltipTrigger>
          <TooltipContent>{reason}</TooltipContent>
        </Tooltip>
      ) : (
        control
      )}
      {onProviderChange && (providers.length > 1 || provider !== undefined) && (
        <DisplayProviderPicker
          id={`${id}-provider`}
          value={provider}
          onChange={onProviderChange}
          providers={providers}
          defaultProvider={node?.virtualDisplayProvider ?? DEFAULT_VIRTUAL_DISPLAY_PROVIDER}
        />
      )}
      <p id={`${id}-hint`} className="text-detail text-muted-foreground">
        Run graphical apps on a machine without a monitor.
      </p>
      <p id={`${id}-cost`} className="text-detail text-warning">
        Uses extra memory and CPU. Not required for web app previews.
      </p>
      {reason && (
        <p id={`${id}-reason`} className="text-detail text-warning">
          {needsSetup ? (
            <a
              href="https://docs.subshell.sh/guides/preview#use-a-virtual-display-on-linux"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Set up virtual display
            </a>
          ) : (
            reason
          )}
        </p>
      )}
      {shouldCheck && reason && !check.isFetching && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void check.refetch()}>
          Recheck
        </Button>
      )}
      {node && node.virtualDisplayEnabled !== true && (
        <Link to="/nodes/$id" params={{ id: node.id }} onClick={onLeave} className="text-detail text-primary underline">
          Open node settings
        </Link>
      )}
      {node && !node.canManage && node.virtualDisplayEnabled !== true && (
        <p className="text-detail text-warning">
          {node.kind === "local"
            ? "An admin can enable virtual displays."
            : "Only this node’s owner can enable virtual displays."}
        </p>
      )}
    </div>
  );
}
