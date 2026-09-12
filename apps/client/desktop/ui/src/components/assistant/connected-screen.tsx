/**
 * This Mac Is a Node — the screen for a machine that is working.
 *
 * One decision on the face of it: open the control plane. Everything else a
 * working machine can still be asked for lives under **More…**, because a
 * person who opens this window while the node is healthy is almost always
 * going somewhere else (spec 2026-09-12 § 6.4).
 *
 * What is under there is every address-shaped thing, in one place, and that
 * grouping is the point: `planeUrl` (what this APP opens) and the node's own
 * `serverUrl` (what the DAEMON dials) are two independent values that can
 * drift, and every surface used to show exactly one of them — so a drift was
 * invisible, and the app would show you a control plane while this machine's
 * subshells reported to a different one. `plane-coherence.ts` notices; the
 * notice sits next to both values and the button that reconciles them.
 */
import { Bot, ExternalLink, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { DetailsDisclosure } from "@/components/assistant/details-disclosure";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NodeCommands } from "@/hooks/use-node-commands";
import type { ActionResult, EnrolledNodeBody, NodeSettings, Probe } from "@/lib/ipc";
import { planeCoherence } from "@/lib/plane-coherence";
import { isLoopback, paneRisk } from "@/lib/steps";

export function ConnectedScreen(props: {
  shell: FrameShell;
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  enrolledNode: EnrolledNodeBody | null;
  output: ActionResult | null;
  commands: NodeCommands;
  busy: boolean;
  platform: string;
  onReenroll: () => void;
  onReset: () => void;
}) {
  const { shell, probe, settings, enrolledNode, output, commands, busy, platform, onReenroll, onReset } = props;
  const planeUrl = settings?.planeUrl ?? null;
  const nodeServerUrl = probe?.status?.serverUrl ?? null;
  const divergence = planeCoherence(planeUrl, nodeServerUrl);
  const [editingPlane, setEditingPlane] = useState(false);
  const [planeTyped, setPlaneTyped] = useState("");
  const [editingNode, setEditingNode] = useState(false);
  const [nodeTyped, setNodeTyped] = useState("");

  /**
   * The node's name, and ONLY when this session chose it: `status --json`
   * reports nodeId/serverUrl/online and no name, and `config.json`'s name is
   * not among the facts the Rust side hands out. Guessing it from the hostname
   * would be showing a default as a fact.
   */
  const named = enrolledNode?.nodeId === probe?.status?.nodeId ? enrolledNode?.name : undefined;

  return (
    <Frame
      {...shell}
      icon={<Bot />}
      barRight={
        <Button className="min-w-[120px]" disabled={busy} onClick={() => commands.openPlane(null)}>
          <ExternalLink aria-hidden />
          Open Subshell Client
        </Button>
      }
    >
      {named && (
        <p className="text-center text-sm">
          Enrolled as <span className="font-semibold">{named}</span>.
        </p>
      )}

      <details className="mt-6 w-full">
        <summary className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">More…</summary>

        <div className="mt-4 flex flex-col gap-4 text-xs">
          {/* Which plane this APP opens. */}
          <div>
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
                <Label htmlFor="plane-url" className="text-muted-foreground text-xs">
                  Server URL
                </Label>
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setEditingPlane(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-muted-foreground">
                  This app opens <span className="break-all font-mono">{planeUrl ?? "nothing yet"}</span>
                </p>
                <div className="flex shrink-0 gap-2">
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
                  <Button variant="outline" size="sm" disabled={busy} onClick={commands.openPlaneUrl}>
                    Open in browser instead
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Which plane this MACHINE'S NODE reports to. */}
          {nodeServerUrl && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-muted-foreground">
                  This node reports to <span className="break-all font-mono">{nodeServerUrl}</span>
                </p>
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

              {/*
               * The enroll-time loopback trap, at rest rather than at
               * enrolment. A node pointed at `localhost` dials a control plane
               * on ITS OWN machine: correct when the plane runs here, wrong
               * whenever the address was copied out of a browser on another
               * box — and silent either way, because the node comes up
               * "online" against nothing.
               */}
              {isLoopback(nodeServerUrl) && (
                <p role="status" aria-label="Loopback control plane" className="flex items-start gap-2">
                  <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <span className="text-muted-foreground">
                    This is a loopback address, so this node looks for a control plane on this machine. That is right if
                    the server runs here, and wrong if the address came from a browser somewhere else.
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
                  <Label htmlFor="node-server-url" className="text-muted-foreground text-xs">
                    Control plane this node reports to
                  </Label>
                  <p className="text-muted-foreground">
                    Keeps this node's identity, and no setup key is spent, so this works when the new address is the
                    same control plane under another name. A different control plane holds no key for this node and will
                    refuse it. The agent reads its configuration at start, so restart it afterwards to apply, and this
                    app's own control-plane window moves to the new address too.
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
                  {/*
                   * The condition this app CANNOT check, so it has to be
                   * stated. A repoint keeps the node id and node key, so it
                   * works only when the two addresses are one plane under two
                   * names — the common case, and the reason this exists.
                   */}
                  <p className="text-muted-foreground">
                    Repointing keeps this node's identity, so it works when both are the same control plane under two
                    names. A different control plane holds no key for this node and will refuse it. The node would go
                    offline, and joining that one means enrolling with a setup key from it.
                  </p>
                  {/*
                   * Said here because this is the path where the omission
                   * actively misleads: the button rewrites `config.json`, and
                   * this notice is computed FROM that file, so it disappears on
                   * the next probe while the running daemon is still attached
                   * to the old plane.
                   */}
                  <p className="text-muted-foreground">
                    This notice clears as soon as the file changes, but the running agent keeps using the old address
                    until it restarts.
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

          <div className="flex flex-wrap gap-2">
            {/*
             * A newer bundled agent is OFFERED, never applied unasked:
             * installing it stops the service that runs the old one. The
             * reverse — a newer agent already installed — is adopted silently
             * and is not a choice.
             */}
            {probe?.agentChoice === "upgrade-available" && (
              <Button variant="outline" size="sm" disabled={busy} onClick={commands.updateAgent}>
                Update the agent to {probe.bundledVersion}
              </Button>
            )}
            {paneRisk(probe) && (
              <Button variant="outline" size="sm" disabled={busy} onClick={commands.rewrite}>
                Rewrite the service definition
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={busy} onClick={onReenroll}>
              Re-enroll…
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={onReset}>
              Reset Subshell…
            </Button>
          </div>
        </div>
      </details>

      <DetailsDisclosure probe={probe} settings={settings} enrolledNode={enrolledNode} output={output} />
    </Frame>
  );
}
