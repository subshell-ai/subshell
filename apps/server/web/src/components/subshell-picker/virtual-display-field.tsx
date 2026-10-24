import { Label, type Node } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function virtualDisplayReason(node: Node | null): string | undefined {
  if (!node) return "Choose a machine first.";
  if (node.os !== "linux") return "Virtual displays are available on Linux machines only.";
  if (node.previewEnabled !== true) return "Turn on Allow preview in this machine's node settings first.";
  return undefined;
}

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
  const reason = virtualDisplayReason(node);
  // A machine change must not carry an unsupported display into the next launch.
  useEffect(() => {
    if (reason && checked) onChange(false);
  }, [reason, checked, onChange]);
  const control = (
    <div className="flex items-center gap-3">
      <Checkbox
        id={id}
        checked={checked}
        disabled={Boolean(reason)}
        onCheckedChange={onChange}
        aria-describedby={`${id}-hint`}
      />
      <Label htmlFor={id}>Virtual display</Label>
    </div>
  );
  return (
    <div className="space-y-2 border-t pt-3">
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
        {reason ??
          "Gives this subshell its own screen. Choose Preview in its workspace, then View screen. The machine needs Xvfb, x11vnc, and xauth installed."}
      </p>
      {node && node.previewEnabled !== true && (
        <Link to="/nodes/$id" params={{ id: node.id }} onClick={onLeave} className="text-detail text-primary underline">
          Open node settings
        </Link>
      )}
      {node && !node.canManage && node.previewEnabled !== true && (
        <p className="text-detail text-warning">
          {node.kind === "local" ? "An admin can enable preview." : "Only this node’s owner can enable preview."}
        </p>
      )}
    </div>
  );
}
