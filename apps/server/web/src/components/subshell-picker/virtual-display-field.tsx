import { Button, Label, type Node } from "@internal/node-admin";
import { DEFAULT_VIRTUAL_DISPLAY_PROVIDER } from "@internal/subshell-protocol";
import { Link } from "@tanstack/react-router";
import { DisplayMissingRequirements } from "@/components/display-missing-requirements";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNodeDisplayReadiness } from "@/hooks/use-node-display-readiness";
import { nodeDefaultForMachine, offeredDisplayProviders } from "@/lib/display-provider-choice";
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
  disabledReason,
  reasonOverride,
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
   * Why this control is off-limits for THIS viewer (access, not availability):
   * the tooltip names it, and unlike an availability reason it disables the
   * box in BOTH directions, because either flip is refused for this viewer.
   * A disabled checkbox still reads its checked state, so nobody loses sight
   * of a live display. Availability blockers keep the checked box live (see
   * `reasonOverride` for whose availability cannot be asked here).
   */
  disabledReason?: string;
  /**
   * Replaces the readiness `reason` everywhere it is consumed: the checkbox's
   * availability half, the tooltip blocker fold, the `aria-describedby` reason
   * entry, and the gold line. It exists for callers whose availability
   * question cannot be asked here, like a picker row on a pane whose node this
   * viewer cannot see: the node is fixed and named, and "choose a node" would
   * be a lie. Launch callers never pass it, and nothing renders differently
   * when it is absent.
   */
  reasonOverride?: string;
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
  // the node's own readiness answer to rule. An OS that has not answered is no
  // verdict at all (`providersForMachine`), so the row keeps offering what the
  // node holds and the kept pick stays visible beside the name it carries. What
  // it does keep showing, by `offeredDisplayProviders`, is a pick the node has
  // not enabled: the gold reason beside this row tells the person to choose
  // another provider, and a trigger reading "Node default" hides the choice that
  // sentence is about.
  const providers = offeredDisplayProviders(
    node?.virtualDisplayProviders ?? [DEFAULT_VIRTUAL_DISPLAY_PROVIDER],
    node?.os,
    provider,
  );
  const defaultProvider = nodeDefaultForMachine(node?.virtualDisplayProvider, node?.os);
  // The override, when given, IS this control's availability story: it feeds
  // the disable expression, the tooltip, the aria entry, and the gold line,
  // exactly where the hook's reason would. With both new props absent every
  // expression below evaluates to what it rendered before they existed.
  const effectiveReason = reasonOverride ?? reason;
  // One blocker string decides the tooltip branch: the viewer's access limit
  // reads through the same explain-yourself wrapper the availability reason
  // already uses.
  const blocker = disabledReason ?? effectiveReason;
  // A CHECKED box with an availability blocker is not "unavailable": the off
  // path stays live for it (the disable rule below keeps a checked box
  // clickable), so the label names the reason alone and cannot contradict the
  // control it wraps. The prefix stays for the unchecked box, where the reason
  // really does block turning one on.
  const blockerLabel =
    disabledReason ?? (checked ? (effectiveReason ?? "") : `Virtual display unavailable. ${effectiveReason}`);
  const control = (
    <div className="flex items-center gap-3">
      <Checkbox
        id={id}
        checked={checked}
        // Two kinds of blocker, two rules: an ACCESS blocker (`disabledReason`)
        // disables both directions, because the server refuses either flip for
        // this viewer (a disabled box still reads its checked state). An
        // AVAILABILITY blocker disables only the unchecked box, so a person
        // can always turn a display off, even while the node's settings say
        // odd things about starting one.
        disabled={(Boolean(effectiveReason) && !checked) || Boolean(disabledReason)}
        onCheckedChange={onChange}
        aria-describedby={[
          `${id}-hint`,
          `${id}-cost`,
          ...(effectiveReason ? [`${id}-reason`] : []),
          ...(resetReason ? [`${id}-reset`] : []),
          ...(launchError && checked ? [`${id}-launch-error`] : []),
        ].join(" ")}
      />
      <Label htmlFor={id}>Virtual display</Label>
    </div>
  );
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      {blocker ? (
        <Tooltip>
          <TooltipTrigger
            render={
              // biome-ignore lint/a11y/useSemanticElements: a native button cannot contain the checkbox; this focusable wrapper explains why it is disabled.
              <span role="button" aria-disabled={true} tabIndex={0} className="inline-flex" aria-label={blockerLabel} />
            }
          >
            {control}
          </TooltipTrigger>
          <TooltipContent>{blocker}</TooltipContent>
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
      {/* The refusal is this checkbox's own result, so it reads here only while
          the box is on. Turning the display off does not discard the message:
          `splitLaunchError` sees the same condition and hands the line to the
          form, where it still explains why the last launch failed. */}
      {checked && launchError && (
        <p id={`${id}-launch-error`} role="alert" className="text-destructive text-detail">
          {launchError}
        </p>
      )}
      <p id={`${id}-cost`} className="text-detail text-warning">
        Uses extra memory and CPU. Not required for web app previews.
      </p>
      {effectiveReason && (
        <p id={`${id}-reason`} className="text-detail text-warning">
          {needsSetup ? (
            <a href="https://docs.subshell.sh/previews/setup" target="_blank" rel="noreferrer" className="underline">
              Set up virtual display
            </a>
          ) : (
            effectiveReason
          )}
        </p>
      )}
      {needsSetup && <DisplayMissingRequirements missing={check.data?.missing} />}
      {/* One story for the reason everywhere, Recheck included. Inert for every
          current caller: `shouldCheck` needs a node, and a caller without one
          (the picker row that passes the override) never reaches this line. */}
      {shouldCheck && effectiveReason && !check.isFetching && (
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
            : "Only the node's owner or a Manage grantee can enable virtual displays."}
        </p>
      )}
    </div>
  );
}
