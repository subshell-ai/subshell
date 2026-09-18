/**
 * This Machine — the screen a configured client lands on, every launch.
 *
 * It evolves from `connected-screen.tsx` and subsumes it — and, with it, the
 * `service` and `install-agent` screens, which are gone: `clientScreen` routes
 * every configured client here, so a screen nothing routes to is a screen that
 * cannot be reached. The rule it exists
 * to hold is spec 2026-09-18 § 2: **nothing opens the control plane's window
 * by itself any more.** A configured client comes up HERE, and the dashboard
 * appears when someone presses the button for it — which is why that button
 * is the one primary in the bar, and why this screen has to be able to answer
 * every state a configured machine can be in rather than only the healthy one.
 *
 * What came across from the two screens it absorbed, each because losing it
 * would have cost something the machine cannot recover on its own: the config
 * and agent-log reveals (`openPath`), the offline diagnosis and the log
 * location that answers it, the pane-safety card whose button the CLI's own
 * restart refusal names BY LABEL, and — the one that is a safety property
 * rather than an affordance — the two ways `no-agent` reads, which decide
 * whether registration may be offered at all.
 *
 * So there are two axes, and they are independent:
 *
 * - **Is this machine a node?** A client that only ever watched a server is a
 *   perfectly ordinary configured client; it gets **Register this machine**.
 *   One that IS enrolled gets the reverse — **Unregister this machine…**,
 *   which is the existing reset flow under the name of what it does to the
 *   machine (it deletes the node config and the node key).
 * - **Is its agent running?** A stopped, offline or serviceless node lands
 *   here too now, so the contextual service verb (`serviceAction`) is offered
 *   on the thing that is wrong instead of on a screen nobody routes to. This
 *   screen must never be a dead end.
 *
 * Everything the connected screen kept under **More…** is still under More…,
 * and the grouping is still the point: `planeUrl` (what this APP opens) and
 * the node's own `serverUrl` (what the DAEMON dials) are two independent
 * values that can drift, every other surface shows exactly one of them, and
 * `plane-coherence.ts` is what notices. The notice sits between both values
 * and the button that reconciles them.
 */
import { Bot, ExternalLink, Server, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { DetailsDisclosure } from "@/components/assistant/details-disclosure";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NodeCommands } from "@/hooks/use-node-commands";
import { tmuxHint } from "@/lib/copy";
import type { ActionResult, EnrolledNodeBody, NodeSettings, Probe, ProbeStep } from "@/lib/ipc";
import { serviceAction } from "@/lib/node-assistant-state";
import { planeCoherence } from "@/lib/plane-coherence";
import { isLoopback, PROBE_STEPS, paneRisk, stepLabel, stepTone, type Tone } from "@/lib/steps";

/** The chip's variant per tone — the badge palette, keyed by the step's own colour. */
const TONE_BADGE: Record<Tone, "success" | "warning" | "destructive" | "muted"> = {
  ok: "success",
  warn: "warning",
  bad: "destructive",
  neutral: "muted",
};

/**
 * Why the agent is not answering — one sentence per step, this screen's OWN.
 *
 * They began as `subtitles.ts`'s three service-screen subtitles and are no
 * longer a copy of them. Saying they were carried across unchanged would be
 * false twice over: that screen is gone, so `subtitles.ts` holds nothing to
 * agree WITH, and two of the three had to change to survive the move.
 *
 * - **`stopped` says more than it did.** As a subtitle it sat under the title
 *   "The Node Service Is Stopped", which had already named the problem; here
 *   it sits in a card under a heading that reads "Subshell Client", so the
 *   sentence has to carry the consequence itself — nothing can launch here.
 * - **`no-service` lost its other branch.** The subtitle chose between a
 *   registered machine and one that is not; this card renders only when
 *   `enrolled`, so "Nothing keeps the agent running" is unreachable and
 *   keeping it would be copy no one can ever read.
 * - **`offline` is word for word the old one**, because a sentence about a
 *   manager claiming a process that nothing is heartbeating from needs no
 *   context around it to be read.
 *
 * {@link serviceDetail} is the other half, and that one IS verbatim.
 */
function serviceProblem(step: ProbeStep): string | null {
  switch (step) {
    case "stopped":
      return "The background service is installed, but the agent is not running, so nothing can launch on this machine.";
    case "offline":
      return "The service manager reports the agent as running, but no local daemon is heartbeating.";
    case "no-service":
      return "This machine is registered, but nothing keeps its agent running.";
    default:
      return null;
  }
}

/**
 * The second sentence — what to DO about it, or what the verb will write.
 *
 * Carried over from the service screen this card replaces. The offline one is
 * the whole diagnosis for the state that is hardest to read (a crash loop and
 * a healthy start look identical for a few seconds), and the no-service one
 * says what pressing the button writes on this machine, which is the only
 * thing on the screen that is not reversible by pressing it again.
 */
function serviceDetail(step: ProbeStep): string | null {
  switch (step) {
    case "offline":
      return (
        "An agent that starts, fails and is restarted on a timer looks exactly like this. Its own log says why: a " +
        "missing tmux, an unreachable control plane, or a node key the server no longer recognises."
      );
    case "no-service":
      return (
        "Running it in the background writes a user-level service definition (a systemd user unit on Linux, a " +
        "launchd agent on macOS) that starts the agent at login and brings it back if it exits."
      );
    default:
      return null;
  }
}

export function StatusScreen(props: {
  shell: FrameShell;
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  enrolledNode: EnrolledNodeBody | null;
  output: ActionResult | null;
  commands: NodeCommands;
  busy: boolean;
  /** Start the node registration flow — for a client that is not a node yet. */
  onRegister: () => void;
  onReenroll: () => void;
  /** Unregister this machine: the reset flow, which is what deletes the node. */
  onReset: () => void;
  /**
   * Open the one update screen — the app AND the agent it ships.
   *
   * It was `onCheckAppUpdate`, and the rename is the change: this screen used
   * to offer TWO updates, one of which quietly did half the job (spec
   * 2026-09-18 § 7.4).
   */
  onUpdate: () => void;
}) {
  const { shell, probe, settings, enrolledNode, output, commands, busy } = props;
  const { onRegister, onReenroll, onReset, onUpdate } = props;
  const planeUrl = settings?.planeUrl ?? null;
  const nodeServerUrl = probe?.status?.serverUrl ?? null;
  const divergence = planeCoherence(planeUrl, nodeServerUrl);
  const [editingPlane, setEditingPlane] = useState(false);
  const [planeTyped, setPlaneTyped] = useState("");
  const [editingNode, setEditingNode] = useState(false);
  const [nodeTyped, setNodeTyped] = useState("");

  /** Whether this machine is a node at all — the axis the whole screen turns on. */
  const enrolled = Boolean(probe?.status?.nodeId);
  /**
   * The address the primary button will land on. `node_open_plane(null)`
   * re-reads Rust's own ladder, which falls back to the node's `serverUrl`
   * when no preference is stored — so the button is offered on exactly the
   * cases that ladder can answer, and the address it names is the one it will
   * open.
   */
  const dashboardUrl = planeUrl ?? nodeServerUrl;
  const action = probe ? serviceAction(probe.step) : null;
  const problem = probe ? serviceProblem(probe.step) : null;
  const detail = probe ? serviceDetail(probe.step) : null;
  /** tmux is a gate, not a caption: a service that starts without it 409s every launch. */
  const blocked = probe !== undefined && !probe.tmux;

  /**
   * Whether this build knows the step at all.
   *
   * A step this app predates means the agent is newer than the app managing
   * it, and the honest thing is to say so rather than to assert anything about
   * the machine — and, above all, rather than to offer registration, which
   * spends a key on a machine whose state is unread. The service screen used
   * to be where an unrecognised step landed, for exactly this reason: it was
   * the one that showed the facts and the last output.
   */
  const known = probe === undefined || (PROBE_STEPS as readonly string[]).includes(probe.step);
  /**
   * A binary answered `version` but not `status --json`.
   *
   * The Rust side folds this into `no-agent` DELIBERATELY (control.rs): reading
   * it as "not enrolled" would offer the act that overwrites `config.json`,
   * mints a second node row and discards the node key whose only home is that
   * file. So this screen must not offer registration here either — a transient
   * read failure is not consent, and the register chain sends `confirm: true`,
   * which is precisely what would blow past the Rust side's own guard.
   */
  const mute = probe?.step === "no-agent" && probe.agent != null;
  /**
   * Nothing on the resolution ladder answered at all.
   *
   * The one case where installing is safe UNCONFIRMED — there is nothing to
   * stop, overwrite or downgrade — and the reason it is offered on its own
   * rather than folded into Register: a machine with no agent cannot say
   * whether it already has a node config, so the install comes first and the
   * probe that follows is what reveals which machine this is.
   */
  const noAgent = probe?.step === "no-agent" && probe.agent == null;

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
      tightContent
      icon={enrolled ? <Bot /> : <Server />}
      barLeft={
        <>
          {/*
           * Re-reading is not a decision, so it sits with the ghosts — and this
           * is the screen someone waits on while they fix the machine from a
           * terminal, where the background poll is too slow to feel like an
           * answer to "I just installed tmux".
           */}
          <Button variant="ghost" disabled={busy} onClick={commands.refresh}>
            Refresh
          </Button>
          {/*
           * The two reveals the service screen carried, and they follow the
           * agent rather than the screen: a machine with no node has no config
           * directory and no agent log, so offering them there would be two
           * buttons whose only outcome is the Rust side's refusal.
           *
           * The log one is offered on every platform even though Linux has no
           * log FILE: the rejection IS the `journalctl` command to run, which
           * is the actionable answer and the only place a user would find it.
           */}
          {enrolled && (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => commands.openPath("config-dir")}>
                Reveal configuration
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => commands.openPath("agent-log")}>
                Open the agent log
              </Button>
            </>
          )}
        </>
      }
      barRight={
        dashboardUrl ? (
          <Button className="min-w-[120px]" disabled={busy} onClick={() => commands.openPlane(null)}>
            <ExternalLink aria-hidden />
            Open Dashboard
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <Badge variant={TONE_BADGE[stepTone(probe?.step)]}>{stepLabel(probe?.step)}</Badge>
        {/*
         * Said here only where the subtitle cannot say it. `subtitleFor`
         * already names the address in BOTH branches — "This machine is a node
         * of <url>." when enrolled, "Connected to <url>." when not — so an
         * enrolled machine needs a sentence here only for the one fact the
         * subtitle lacks, which is the NAME it enrolled under. Not enrolled is
         * the other way round: "Connected to <url>" says nothing about whether
         * subshells can run here, so that sentence stays.
         */}
        {enrolled ? (
          named ? (
            <p className="text-sm">
              Enrolled as <span className="font-strong">{named}</span>. Subshells can run on this machine.
            </p>
          ) : null
        ) : (
          <p className="text-sm">This machine is not registered as a node, so no subshells run on it.</p>
        )}
      </div>

      {/*
       * The machine is a node and its agent is not answering. On the thing
       * that failed, with the step's own verb — a landing screen that only
       * worked for a healthy node would strand every other machine here.
       */}
      {/*
       * A step this build predates. The screen says so instead of asserting
       * something about the machine, and — more importantly — offers nothing
       * that spends anything: the badge reads "Unknown", `serviceAction` has
       * no verb, and the register invitation below is withheld. Refresh and
       * Show Details, which are what make an unrecognised state diagnosable,
       * stay live.
       */}
      {probe && !known && (
        <div className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-detail leading-relaxed">
            This app does not recognise the state "{probe.step}", which usually means it is older than the agent it is
            managing.
          </p>
        </div>
      )}

      {/*
       * The repair the install screen owned, and the refusal that went with it.
       *
       * `no-agent` covers two very different machines and keeping them apart
       * is the whole care here (it is why `install-agent-screen.tsx` existed):
       *
       * - **Nothing answered at all.** Installing is safe unconfirmed — there
       *   is nothing to stop, overwrite or downgrade — and it is offered on
       *   its own rather than folded into Register, because a machine with no
       *   agent cannot say whether it is ALREADY a node. Register's chain
       *   enrolls with `confirm: true`, so offering it here would overwrite a
       *   live `config.json` and discard its node key on a machine this app
       *   never got to read. Install first; the probe that follows says which
       *   machine this is, and Register appears then if it is not one.
       * - **A binary answered `version` but not `status --json`.** Nothing is
       *   offered: the remedy for a binary that cannot state its own status is
       *   a different binary on the machine — this app resolves one from the
       *   service definition, PATH and its own install, and no longer offers
       *   to be pointed at a file — and the probe's own `error` is already on
       *   the problem line above.
       */}
      {mute && (
        <div className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-detail leading-relaxed">
            Nothing has been changed. This app will not offer to register a machine whose agent cannot say whether it is
            already a node: enrolling overwrites the existing configuration and discards its node key.
          </p>
        </div>
      )}

      {noAgent && (
        <div className="mt-6 rounded-md border border-border p-3">
          <p className="text-detail leading-relaxed">
            The agent is the small program that holds this machine's connection to the control plane and starts the
            sessions launched here. Installing it copies the copy that ships inside this app to ~/.local/bin/subshell,
            and nothing is downloaded.
          </p>
          {probe?.bundledVersion ? (
            <div className="mt-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={commands.installAgent}>
                Install the agent
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-muted-foreground text-detail">
              This build ships no agent, so one has to be installed on this machine some other way.
            </p>
          )}
        </div>
      )}

      {enrolled && action && (
        <div className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3">
          {problem && <p className="text-detail leading-relaxed">{problem}</p>}
          {detail && <p className="mt-2 text-detail text-muted-foreground leading-relaxed">{detail}</p>}
          <div className="mt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || blocked}
              onClick={() => {
                // `restart` has its own two-phase path: the CLI's refusal is
                // read out loud before `--force` is offered as its own button.
                if (action.verb === "restart") commands.restart();
                else commands.service(action.verb, { settle: true });
              }}
            >
              {action.label}
            </Button>
          </div>
          {blocked && <p className="mt-2 text-detail text-warning">{tmuxHint(probe, "service")}</p>}
          {/*
           * Where the log lives, on the one state whose cause is only IN the
           * log — a crash loop inside its restart window is indistinguishable
           * from a healthy start from out here. On Linux this is the
           * `journalctl` line, which is the only place a person finds it.
           */}
          {probe?.step === "offline" && probe.paths?.agentLogHint && (
            <p className="mt-2 text-detail text-muted-foreground">{probe.paths.agentLogHint}</p>
          )}
        </div>
      )}

      {/*
       * The one remedy that survived the card page's action row, and it is on
       * the face of the screen rather than under More… because the restart
       * refusal names it BY LABEL: "the button labelled Rewrite the service
       * definition is the CLI's own first suggestion". A definition without
       * `KillMode=process` / `AbandonProcessGroup` SIGKILLs every pane on this
       * machine on any teardown, so it is worth a sentence, not just a button.
       */}
      {paneRisk(probe) && (
        <div className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-detail leading-relaxed">
            The installed service definition does not spare live panes, so stopping or restarting the agent kills every
            subshell running on this machine.
          </p>
          <div className="mt-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={commands.rewrite}>
              Rewrite the service definition
            </Button>
          </div>
        </div>
      )}

      {/*
       * A client that only ever watched a server. Offered as the screen's own
       * invitation rather than as the bar's primary: this person came to look
       * at a dashboard, and registering their machine is the second thing they
       * might want, not the thing they are here for.
       *
       * Withheld on the three states above, and each withholding is safety
       * rather than tidiness: registering spends a single-use key and enrolls
       * with `confirm: true`, so it may only be offered on a machine this app
       * has actually READ — hence `probe` as well as `known` — and found to be
       * no node.
       */}
      {probe !== undefined && !enrolled && known && !mute && !noAgent && (
        <div className="mt-6 rounded-md border border-border p-3">
          <p className="text-detail leading-relaxed">
            Registering installs the agent, enrolls this machine with a setup key from that server, and runs it in the
            background so subshells can be launched here.
          </p>
          <div className="mt-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={onRegister}>
              Register this machine
            </Button>
          </div>
        </div>
      )}

      <details className="mt-6 w-full">
        <summary className="cursor-pointer text-muted-foreground text-detail hover:text-foreground">More…</summary>

        <div className="mt-4 flex flex-col gap-4 text-detail">
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
                <Label htmlFor="plane-url" className="text-muted-foreground text-detail">
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
                  <Label htmlFor="node-server-url" className="text-muted-foreground text-detail">
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
             * A newer bundled agent is still announced HERE — this is the
             * natural place to notice the agent is behind — but the button is
             * a DOOR now (spec 2026-09-18 § 7.4). It used to install the agent
             * on the spot, which was half an act: this app SHIPS that agent,
             * so a machine whose bundled agent is newer usually has a newer app
             * waiting too, and installing one of the two in isolation is what
             * produced the loop where the next launch asked again.
             */}
            {probe?.agentChoice === "upgrade-available" && (
              <Button variant="outline" size="sm" disabled={busy} onClick={onUpdate}>
                Update the agent to {probe.bundledVersion}
              </Button>
            )}
            {/*
             * The same screen, for the case where nothing on this machine says
             * anything is behind. Always offered rather than gated on a known
             * update: whether one exists is a network read, and a row that
             * appeared only after an answer would mean asking on the probe's
             * clock — which is the background update check this design
             * explicitly does not have.
             */}
            <Button variant="outline" size="sm" disabled={busy} onClick={onUpdate}>
              Check for updates…
            </Button>
            {/*
             * Re-enrolling is a thing you do to a machine that IS enrolled —
             * it overwrites `config.json` and mints a second node row. On a
             * machine that is not one, the act with that meaning is
             * **Register this machine** above, so offering both would be two
             * buttons for one thing under two names.
             */}
            {enrolled && (
              <Button variant="outline" size="sm" disabled={busy} onClick={onReenroll}>
                Re-enroll…
              </Button>
            )}
          </div>
        </div>
      </details>

      <DetailsDisclosure probe={probe} settings={settings} enrolledNode={enrolledNode} output={output} />

      {/*
       * The one destructive act, and it is NAMED for what it does to this
       * machine rather than for the flow behind it: reset is what unregisters.
       * Deliberately not a button beside the primary — it is the opposite of
       * what a person opens this window for — and deliberately not repeated
       * under More…, because one act with two labels is two acts to a reader.
       */}
      {enrolled && (
        <p className="mt-6">
          <button
            type="button"
            className="rounded-sm text-detail text-muted-foreground underline-offset-2 hover:text-destructive hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            onClick={onReset}
            disabled={busy}
          >
            Unregister this machine…
          </button>
        </p>
      )}
    </Frame>
  );
}
