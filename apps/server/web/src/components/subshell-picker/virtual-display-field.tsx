import { Button, Label, type Node } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNodeDisplayReadiness } from "@/hooks/use-node-display-readiness";

export function VirtualDisplayField({
  node,
  id,
  checked,
  onChange,
  onLeave,
}: {
  node: Node | null;
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  onLeave?: () => void;
}) {
  const { check, reason, needsSetup, shouldCheck } = useNodeDisplayReadiness(node);
  const previousNode = useRef(node?.id);
  // Revalidating the same machine must not discard the user's selection.
  // A different machine or a completed refusal does invalidate it.
  useEffect(() => {
    const changedNode = previousNode.current !== node?.id;
    previousNode.current = node?.id;
    if (checked && (changedNode || (reason && !check.isFetching))) onChange(false);
  }, [node?.id, reason, check.isFetching, checked, onChange]);
  const control = (
    <div className="flex items-center gap-3">
      <Checkbox
        id={id}
        checked={checked}
        disabled={Boolean(reason)}
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
      {node && node.viewsEnabled !== true && (
        <Link to="/nodes/$id" params={{ id: node.id }} onClick={onLeave} className="text-detail text-primary underline">
          Open node settings
        </Link>
      )}
      {node && !node.canManage && node.viewsEnabled !== true && (
        <p className="text-detail text-warning">
          {node.kind === "local"
            ? "An admin can enable Apps & screens."
            : "Only this node’s owner can enable Apps & screens."}
        </p>
      )}
    </div>
  );
}
