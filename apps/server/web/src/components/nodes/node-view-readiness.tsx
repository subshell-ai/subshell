import { Button, type NodeDetail } from "@internal/node-admin";
import { DisplayMissingRequirements } from "@/components/display-missing-requirements";
import { useNodeDisplayReadiness } from "@/hooks/use-node-display-readiness";

/** Explain machine prerequisites beside the switch that permits these features. */
export function NodeViewReadiness({
  node,
  provider,
  inspect = false,
}: {
  node: NodeDetail;
  provider?: string;
  inspect?: boolean;
}) {
  const { check, reason, needsSetup, shouldCheck } = useNodeDisplayReadiness(node, provider, inspect);
  if (!node.virtualDisplayEnabled && !inspect) {
    return <p className="text-detail text-muted-foreground">Virtual displays are disabled on this node.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p role="status" className={reason ? "text-detail text-warning" : "text-detail text-muted-foreground"}>
        {reason ?? "Virtual display requirements are met."}
      </p>
      {needsSetup && (
        <a
          href={
            provider === "betterdisplay"
              ? "https://docs.subshell.sh/nodes/manage#macos-display-helper"
              : "https://docs.subshell.sh/guides/preview#use-a-virtual-display-on-linux"
          }
          target="_blank"
          rel="noreferrer"
          className="text-detail text-warning underline"
        >
          Set up virtual display
        </a>
      )}
      {needsSetup && <DisplayMissingRequirements missing={check.data?.missing} />}
      {shouldCheck && reason && !check.isFetching && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void check.refetch()}>
          Recheck
        </Button>
      )}
    </div>
  );
}
