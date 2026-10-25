import { Button, type NodeDetail } from "@internal/node-admin";
import { useNodeDisplayReadiness } from "@/hooks/use-node-display-readiness";

/** Explain machine prerequisites beside the switch that permits these features. */
export function NodeViewReadiness({ node }: { node: NodeDetail }) {
  const { check, reason, needsSetup, shouldCheck } = useNodeDisplayReadiness(node);
  if (!node.viewsEnabled) {
    return <p className="text-detail text-muted-foreground">Apps &amp; screens is disabled on this node.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {node.os !== "linux" && (
        <p className="text-detail text-warning">
          Automatic app discovery and browser watching are available on Linux machines only. You can still add HTTP and
          HTTPS services by port.
        </p>
      )}
      <p role="status" className={reason ? "text-detail text-warning" : "text-detail text-muted-foreground"}>
        {reason ?? "Virtual display requirements are met."}
      </p>
      {needsSetup && (
        <a
          href="https://docs.subshell.sh/guides/preview#use-a-virtual-display-on-linux"
          target="_blank"
          rel="noreferrer"
          className="text-detail text-warning underline"
        >
          Set up virtual display
        </a>
      )}
      {shouldCheck && reason && !check.isFetching && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void check.refetch()}>
          Recheck
        </Button>
      )}
    </div>
  );
}
