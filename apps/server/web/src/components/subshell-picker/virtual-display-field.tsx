import { apiFetch, Button, Label, type Node } from "@internal/node-admin";
import { type PreviewDisplayReadiness, parsePreviewDisplayReadiness } from "@internal/subshell-protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function virtualDisplayReason(node: Node | null, readiness?: PreviewDisplayReadiness): string | undefined {
  if (!node) return "Choose a machine first.";
  if (node.os !== "linux") return "Virtual displays are available on Linux machines only.";
  if (node.previewEnabled !== true) return "Turn on Allow apps and screens in this machine's node settings first.";
  if (!readiness) return "Checking virtual display requirements…";
  if (!readiness.supported) return "Virtual displays are available on Linux machines only.";
  if (readiness.missing.length) {
    return "Required virtual display programs are missing on this machine.";
  }
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
  const shouldCheck = Boolean(node && node.os === "linux" && node.previewEnabled === true);
  const check = useQuery({
    queryKey: ["preview-display-readiness", node?.id],
    enabled: shouldCheck,
    queryFn: async () => {
      const data = parsePreviewDisplayReadiness(await apiFetch<unknown>(`/api/nodes/${node?.id}/preview-display`));
      if (!data) throw new Error("Couldn't check virtual display requirements. Choose Recheck to try again.");
      return data;
    },
    retry: false,
    // Moving back to the form must not clear a display the user just selected.
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const reason =
    shouldCheck && check.isFetching
      ? "Checking virtual display requirements…"
      : shouldCheck && check.isError
        ? check.error.message
        : virtualDisplayReason(node, check.data);
  const needsSetup =
    shouldCheck && !check.isFetching && !check.isError && check.data?.supported && check.data.missing.length > 0;
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
        aria-describedby={reason ? `${id}-hint ${id}-reason` : `${id}-hint`}
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
        Gives browsers and other graphical apps launched in this subshell a screen, even without a physical monitor. See
        and control them from Preview → View screen.
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
