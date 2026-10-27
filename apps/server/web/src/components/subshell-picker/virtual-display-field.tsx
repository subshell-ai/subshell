import { Button, Label, type Node } from "@internal/node-admin";
import { DEFAULT_VIRTUAL_DISPLAY_PROVIDER, displayProviderRunsOnOs } from "@internal/subshell-protocol";
import { Link } from "@tanstack/react-router";
import { DisplayMissingRequirements } from "@/components/display-missing-requirements";
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
  resetReason,
  launchError,
}: {
  node: Node | null;
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  onLeave?: () => void;
  provider?: string;
  onProviderChange?: (provider: string | undefined) => void;
  resetReason?: string;
  /**
   * The launch this control lost: a create the node refused over the display
   * (the budget, a provider that does not run here, the switch). It arrives
   * from the dialog because the refusal names the whole launch, but it reads
   * as this checkbox's own result, so it renders here, not at the form's
   * foot. `isDisplayLaunchRefusal` decides which errors are this kind.
   */
  launchError?: string | null;
}) {
  const { check, reason, needsSetup, shouldCheck } = useNodeDisplayReadiness(node, provider);
  // A provider this machine's OS cannot drive is not a choice, so it is not
  // offered: Xvfb is Linux's display server and BetterDisplay is macOS's, and a
  // list that shows the other one sends the person to a launch the machine
  // refuses. The stored list is the owner's, so this narrows what the row shows
  // rather than rewriting it, and an id the catalog does not ship stays put for
  // the node's own readiness answer to rule.
  const providers = (node?.virtualDisplayProviders ?? [DEFAULT_VIRTUAL_DISPLAY_PROVIDER]).filter((id) =>
    displayProviderRunsOnOs(id, node?.os),
  );
  const nodeDefault = node?.virtualDisplayProvider;
  const defaultProvider = nodeDefault && displayProviderRunsOnOs(nodeDefault, node?.os) ? nodeDefault : undefined;
  const control = (
    <div className="flex items-center gap-3">
      <Checkbox
        id={id}
        checked={checked}
        disabled={Boolean(reason) && !checked}
        onCheckedChange={onChange}
        aria-describedby={[
          `${id}-hint`,
          `${id}-cost`,
          ...(reason ? [`${id}-reason`] : []),
          ...(resetReason ? [`${id}-reset`] : []),
          ...(launchError ? [`${id}-launch-error`] : []),
        ].join(" ")}
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
          defaultProvider={defaultProvider}
        />
      )}
      <p id={`${id}-hint`} className="text-detail text-muted-foreground">
        Run graphical apps on a machine without a monitor.
      </p>
      {resetReason && (
        <p id={`${id}-reset`} role="status" className="text-destructive text-detail">
          {resetReason}
        </p>
      )}
      {launchError && (
        <p id={`${id}-launch-error`} role="alert" className="text-destructive text-detail">
          {launchError}
        </p>
      )}
      <p id={`${id}-cost`} className="text-detail text-warning">
        Uses extra memory and CPU. Not required for web app previews.
      </p>
      {reason && (
        <p id={`${id}-reason`} className="text-detail text-warning">
          {needsSetup ? (
            <a
              href="https://docs.subshell.sh/nodes/manage#apps-browsers-and-virtual-displays"
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
      {needsSetup && <DisplayMissingRequirements missing={check.data?.missing} />}
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
