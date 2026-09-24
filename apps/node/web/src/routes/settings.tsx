import { NodeAllowedDirs, NodeServerUrlCard, useNode } from "@internal/node-admin";
import { createFileRoute } from "@tanstack/react-router";
import { LogRetentionCard } from "@/components/log-retention-card";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

/**
 * Node Settings — the machine's own configuration, the same view as the control
 * plane's per-node Configuration tab (the operator's ask), minus what a local
 * edit could not honestly change.
 *
 * The plane's Configuration section carries two rules: where this machine
 * dials, and what may run on it. This page adds a third that lives ONLY here
 * because no plane route exists for it: how long the machine keeps its own
 * pane transcripts. It is `config.json`'s two retention fields, editable
 * through the same local surface `subshell update` has, which is exactly why
 * the card belongs on this page and not inside a shared card (the plane would
 * render an editor for a route it does not have).
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
      <LogRetentionCard />
    </>
  );
}
