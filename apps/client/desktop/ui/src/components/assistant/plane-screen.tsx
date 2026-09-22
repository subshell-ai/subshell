/**
 * Control Plane — the rail section that is the plane address's home (operator
 * ruling 2026-09-22: "where you can re/configure the control plane server").
 * What moved out of the status screen: the configured address and the way to
 * change it, "Open in browser instead", and the node's own view of the same
 * server — its reported address, the repoint machinery, the loopback warning
 * and the coherence notice. The status screen's "This app opens <url>"
 * sentence is DELETED per the ruling: the value is shown labeled, not narrated.
 * Later the same day, Re-enroll… moved here too (operator ruling 2026-09-22):
 * overwriting `config.json` and minting a second node row is an act on this
 * machine's relationship to the plane, which is exactly what this section is
 * for. The enroll screen's own confirm gate is unchanged — the door moved,
 * not the asking. The same day's door rulings put BOTH doors for the plane
 * here, under a **Dashboard** card (the second addendum: "Open in browser"
 * for the system browser, "Open in app" for the in-app window, the existing
 * `node_open_plane` path) — the only place in the app that opens the control
 * plane — and rebuilt the address row into the addresses-card form shape
 * (labeled value row, acts grouped below), because
 * the one-line value with its buttons beside it wrapped the URL
 * character-broken and crowded it. The `bundled` and `tmux` fact rows are
 * NOT here: they render only on the Service section (same day, screenshot
 * 52).
 *
 * Two addresses, and they are independent (the reason the status screen kept
 * them side by side until this split): `planeUrl` (what this APP opens) and
 * the node's own `serverUrl` (what the DAEMON dials) can drift, every other
 * surface shows exactly one of them, and `planeCoherence` is what notices.
 */
import { ExternalLink, TriangleAlert } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { StatusFacts } from "@/components/assistant/status-facts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NodeCommands } from "@/hooks/use-node-commands";
import type { ActionResult, NodeSettings, Probe } from "@/lib/ipc";
import { planeCoherence } from "@/lib/plane-coherence";
import { isLoopback } from "@/lib/steps";

export function PlaneScreen(props: {
  shell: FrameShell;
  /** The rail node the app computed for this screen, or undefined when the screen is full-window. */
  rail?: ReactElement;
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  commands: NodeCommands;
  busy: boolean;
  /**
   * Open the re-enroll flow — for a machine that already IS a node. Offered
   * beside the plane address acts (operator ruling 2026-09-22): the enroll
   * screen's confirm gate is unchanged, so this is a door, not a new act.
   */
  onReenroll: () => void;
  /** The CLI's last words — the address acts' answers, rendered inline below. */
  output: ActionResult | null;
}): ReactElement {
  const { shell, probe, settings, commands, busy, onReenroll, output } = props;
  const planeUrl = settings?.planeUrl ?? null;
  const nodeServerUrl = probe?.status?.serverUrl ?? null;
  /** Re-enroll… overwrites a live `config.json`, so it exists only where there is one. */
  const enrolled = Boolean(probe?.status?.nodeId);
  const divergence = planeCoherence(planeUrl, nodeServerUrl);
  const [editingPlane, setEditingPlane] = useState(false);
  const [planeTyped, setPlaneTyped] = useState("");
  const [editingNode, setEditingNode] = useState(false);
  const [nodeTyped, setNodeTyped] = useState("");

  return (
    <Frame {...shell} rail={props.rail} tightContent>
      {/* Which plane this APP opens — the addresses-card form shape (operator
          ruling 2026-09-22, screenshot 53: the one-line value with its buttons
          beside it wrapped the URL character-broken and crowded it), since
          addendum 4 as its own bordered CARD, matching the Dashboard card
          below it. The label is the operator's exact words (addendum 4), a
          noun rather than the deleted "This app opens <url>" narration, and
          rendered like every other card title in the app (addendum 5:
          `font-strong text-detail`, foreground; the Dashboard rendering is
          the reference, the muted label style was the odd one out). */}
      <div className="rounded-md border border-border p-3">
        <div className="space-y-1.5">
          {/* The title is a Label ONLY while the labeled input exists (delta
              review m-3): a htmlFor with no control in the tree is dead
              pointing. The rendering classes are the same either way. */}
          {editingPlane ? (
            <Label htmlFor="plane-url" className="font-strong text-detail">
              Control plane URL
            </Label>
          ) : (
            <p className="font-strong text-detail">Control plane URL</p>
          )}
          {editingPlane ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (busy || planeTyped.trim() === "") return;
                // Closed unconditionally: the runner surfaces a rejected URL
                // as its own message, and leaving the form open on success
                // would look like nothing happened.
                setEditingPlane(false);
                commands.openPlane(planeTyped);
              }}
            >
              <div className="flex items-center gap-2">
                <Input
                  id="plane-url"
                  value={planeTyped}
                  onChange={(e) => setPlaneTyped(e.target.value)}
                  placeholder="https://subshell.example.com"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  disabled={busy}
                />
                <Button type="submit" size="sm" disabled={busy || planeTyped.trim() === ""}>
                  Open
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditingPlane(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <p className="min-w-0 break-all font-mono text-sm">{planeUrl ?? "nothing yet"}</p>
          )}
        </div>
        {!editingPlane && (
          // The acts, grouped on their own row inside the card (ruling 4,
          // same screenshot): the edit and, for a machine that is a node, the
          // relationship act. Re-enroll… stays where the 0aeb7709 ruling put
          // it; the confirm gate is the enroll screen's, unchanged.
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (busy) return;
                // Seeded: a change is usually an edit of this address,
                // and an empty field makes someone retype a hostname to
                // correct one character of it.
                setPlaneTyped(planeUrl ?? "");
                setEditingPlane(true);
              }}
            >
              Change server…
            </Button>
            {enrolled && (
              <Button variant="outline" size="sm" disabled={busy} onClick={onReenroll}>
                Re-enroll…
              </Button>
            )}
          </div>
        )}
      </div>

      {/* The Dashboard card (operator ruling 2026-09-22, second addendum,
          superseding the same day's "Open the control plane" on the acts
          row): BOTH doors for the plane, under one name — the system browser
          and the in-app window — and the ONLY place in the app that opens
          the control plane. The in-app door is the existing `node_open_plane`
          path, re-reading the settled address; the browser door is
          `node_open_plane_url`. Neither takes a URL argument by design. */}
      <div className="mt-6 rounded-md border border-border p-3">
        <p className="font-strong text-detail">Dashboard</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={commands.openPlaneUrl}>
            <ExternalLink aria-hidden />
            Open in browser
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => commands.openPlane(null)}>
            Open in app
          </Button>
        </div>
      </div>

      {/* Which plane this MACHINE'S NODE reports to — the node's own view of
          the same server, and the only place its repoint machinery lives. */}
      {nodeServerUrl && (
        <div className="mt-6 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Label className="text-muted-foreground text-detail">This node reports to</Label>
              <p className="min-w-0 break-all font-mono text-sm">{nodeServerUrl}</p>
            </div>
            {!editingNode && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                className="shrink-0"
                onClick={() => {
                  if (busy) return;
                  setNodeTyped(nodeServerUrl);
                  setEditingNode(true);
                }}
              >
                Repoint this node…
              </Button>
            )}
          </div>

          {/* The enroll-time loopback trap, at rest rather than at enrolment. A
              node pointed at `localhost` dials a control plane on ITS OWN
              machine: correct when the plane runs here, wrong whenever the
              address was copied out of a browser on another box — and silent
              either way, because the node comes up "online" against nothing. */}
          {isLoopback(nodeServerUrl) && (
            <p role="status" aria-label="Loopback control plane" className="flex items-start gap-2">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span className="text-muted-foreground">
                This is a loopback address, so this node looks for a control plane on this machine. That is right if the
                server runs here, and wrong if the address came from a browser somewhere else.
              </span>
            </p>
          )}

          {editingNode && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (busy || nodeTyped.trim() === "") return;
                // Left OPEN on submit, unlike the plane field above: the
                // CLI's own refusal is the answer to a bad address, and
                // closing would make someone retype the whole URL to fix a
                // character.
                commands.repoint(nodeTyped);
              }}
            >
              <Label htmlFor="node-server-url" className="text-muted-foreground text-detail">
                Control plane this node reports to
              </Label>
              <p className="text-muted-foreground">
                Keeps this node's identity, and no setup key is spent, so this works when the new address is the same
                control plane under another name; a different control plane holds no key for this node and will refuse
                it. The node reads its configuration at start, so restart it afterwards to apply, and this app's own
                control-plane window moves to the new address too.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  id="node-server-url"
                  value={nodeTyped}
                  onChange={(e) => setNodeTyped(e.target.value)}
                  placeholder="https://subshell.example.com"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  disabled={busy}
                />
                <Button type="submit" size="sm" disabled={busy || nodeTyped.trim() === ""}>
                  Repoint
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setEditingNode(false);
                    setNodeTyped("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {divergence !== null && (
            <div
              role="status"
              aria-label="Control plane mismatch"
              className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3"
            >
              <p className="flex items-start gap-2">
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span>{divergence.message}</span>
              </p>
              {/* The condition this app CANNOT check, so it has to be stated.
                  A repoint keeps the node id and node key, so it works only
                  when the two addresses are one plane under two names — the
                  common case, and the reason this exists. */}
              <p className="text-muted-foreground">
                Repointing keeps this node's identity, so it works when both are the same control plane under two names;
                a different control plane holds no key for this node and will refuse it. The node would go offline, and
                joining that one means enrolling with a setup key from it.
              </p>
              {/* Said here because this is the path where the omission
                  actively misleads: the button rewrites `config.json`, and
                  this notice is computed FROM that file, so it disappears on
                  the next probe while the running daemon is still attached to
                  the old plane. */}
              <p className="text-muted-foreground">
                This notice clears as soon as the file changes, but the running node keeps using the old address until
                it restarts.
              </p>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (busy) return;
                    commands.repoint(divergence.planeUrl);
                  }}
                >
                  Use {divergence.planeUrl} for this node
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* The CLI's last words, INLINE — the repoint and open acts' answers
          are this section's own answers. */}
      <StatusFacts probe={probe} settings={settings} enrolledNode={null} output={output} />
    </Frame>
  );
}
