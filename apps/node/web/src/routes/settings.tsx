import { NodeAllowedDirs, NodeServerUrlCard, useNode } from "@internal/node-admin";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

/**
 * Node Settings — the machine's own configuration, the same view as the control
 * plane's per-node Configuration tab (the operator's ask), minus what a local
 * edit could not honestly change.
 *
 * Two rules, and they are the two the plane's Configuration section carries:
 * where this machine dials, and what may run on it.
 *
 * The directory allowlist renders READ-ONLY here on purpose. The plane keeps its
 * own copy, enforces it at launch, and re-pushes this machine's file on every
 * `ready` — so a local edit would be silently overwritten by the next
 * reconnect, which is a worse outcome than an absent control. The card says so
 * itself; the page adds nothing.
 */
function SettingsPage() {
  const node = useNode("self");

  if (node.isError) {
    return (
      <p role="alert" className="text-body text-destructive">
        The node did not answer. It may be restarting.
      </p>
    );
  }
  const n = node.data;
  if (!n) {
    return <p className="text-body text-muted-foreground">Loading…</p>;
  }

  return (
    <>
      <NodeServerUrlCard node={n} />
      <NodeAllowedDirs node={n} readOnly />
    </>
  );
}
