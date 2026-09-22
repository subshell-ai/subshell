/**
 * Control Plane — the rail section that is the plane address's home (operator
 * ruling 2026-09-22: "where you can re/configure the control plane server").
 * What moved out of the status screen: the configured address and the way to
 * change it, and BOTH doors for the plane, under their own **Dashboard** card
 * ("Open in browser" for the system browser, "Open in app" for the in-app
 * window, the existing `node_open_plane` path) — the only place in the app
 * that opens the control plane. The status screen's "This app opens <url>"
 * sentence is DELETED per the ruling: the value is shown labeled, not
 * narrated, and the row carries the addresses-card form shape (labeled value
 * row, acts grouped below), because the one-line value with its buttons beside
 * it wrapped the URL character-broken and crowded it (screenshot 53). The
 * `bundled` and `tmux` fact rows are NOT here: they render only on the
 * Service section (same day, screenshot 52).
 *
 * ONE address (operator ruling 2026-09-22, final addendum): the control plane
 * URL IS what the node reports to; the section shows one value, and the old
 * second block ("This node reports to… / Repoint this node…") and its edit
 * form are gone. **Re-enroll… now means REPOINTING** — the same
 * `node_configure` act the form performed, pressing the card's own address,
 * identity kept, no setup key spent. It appears only while the node actually
 * reports elsewhere (`planeCoherence` is what notices), and vanishes when the
 * pair agrees. The destructive re-enroll (overwrite `config.json`, mint a
 * second row) has no door on this screen anymore: moving to a genuinely
 * different plane means enrolling there.
 */
import { ExternalLink, TriangleAlert } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { ActionOutput } from "@/components/assistant/status-facts";
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
  /** The CLI's last words — the address acts' answers, rendered inline below. */
  output: ActionResult | null;
}): ReactElement {
  const { shell, probe, settings, commands, busy, output } = props;
  const planeUrl = settings?.planeUrl ?? null;
  const nodeServerUrl = probe?.status?.serverUrl ?? null;
  /** Re-enroll… rewrites a live `config.json`, so it exists only where there is one. */
  const enrolled = Boolean(probe?.status?.nodeId);
  const divergence = planeCoherence(planeUrl, nodeServerUrl);
  const [editingPlane, setEditingPlane] = useState(false);
  const [planeTyped, setPlaneTyped] = useState("");

  return (
    <Frame {...shell} rail={props.rail} tightContent>
      {/* THE address (ruling: the plane URL is what the node reports to) —
          the addresses-card form shape (operator
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
                // SAVES ONLY (operator ruling 2026-09-22, addendum 6): the
                // Dashboard card's two doors are the explicit opens; the
                // submit persists the address and nothing else. An
                // instantaneous save also records no receipt (the opens
                // record none either), so the form's feedback is the
                // refetched address itself.
                commands.connectOnly(planeTyped);
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
                  Change
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditingPlane(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <p className="min-w-0 break-all font-mono text-sm">{planeUrl ?? nodeServerUrl ?? "nothing yet"}</p>
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
            {enrolled && divergence !== null && planeUrl && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => commands.repoint(planeUrl)}>
                Re-enroll…
              </Button>
            )}
          </div>
        )}
        {/* The enroll-time loopback trap, at rest rather than at enrolment. A
            node pointed at `localhost` dials a control plane on ITS OWN
            machine: correct when the plane runs here, wrong whenever the
            address was copied out of a browser on another box — and silent
            either way, because the node comes up "online" against nothing. */}
        {nodeServerUrl !== null && isLoopback(nodeServerUrl) && (
          <p role="status" aria-label="Loopback control plane" className="mt-2 flex items-start gap-2">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span className="text-detail text-muted-foreground">
              This is a loopback address, so this node looks for a control plane on this machine. That is right if the
              server runs here, and wrong if the address came from a browser somewhere else.
            </span>
          </p>
        )}
        {/* Where the ONE address and the node's dialing diverge, the card says
            so plainly and the Re-enroll press closes the gap. (Operator ruling
            2026-09-22: one address; Re-enroll means repointing.) The card
            states what IS; the help states what the press changes, in two
            sentences, including the restart and the different-plane refusal
            the old form said in full. */}
        {enrolled && divergence !== null && nodeServerUrl && (
          <div className="mt-2 flex flex-col gap-1.5">
            <p className="min-w-0 break-all text-detail text-muted-foreground">
              Currently the node reports to <span className="font-mono">{nodeServerUrl}</span>.
            </p>
            <p className="text-detail text-muted-foreground">
              Re-enroll points the node at the address above, and the node takes it when it restarts; its identity is
              kept and no setup key is spent. A different control plane will refuse the node until it enrolls there.
            </p>
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

      {/* The repoint and save acts' own words, INLINE — this section's
          actions' answers, as the output block alone (operator ruling
          2026-09-22, screenshot 60: the facts list is Status's alone). */}
      <ActionOutput output={output} />
    </Frame>
  );
}
