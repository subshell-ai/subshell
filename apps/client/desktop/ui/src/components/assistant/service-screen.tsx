/**
 * Service — the rail section that carries the node's own machinery (operator
 * ruling 2026-09-22, live screenshot: "a section called Service and that's
 * where the node install would be if it is not installed"). What moved out of
 * the status screen, and why: the status screen keeps MACHINE state — what
 * this machine is, whether subshells can run on it, what its dashboard is —
 * while the node's install, its service lifecycle and its own log are the
 * machinery a Service section is FOR.
 *
 * The layout and the offerings now MATCH Subshell Server's Service section
 * (operator ruling 2026-09-22, the rails addendum: "consistency in offering
 * and UI"), adapted to a node. The server states the arrangement ("In the
 * background"), nests the run-at-login switch under it, and answers with its
 * own words; this screen says the same about the one arrangement a node has —
 * there is no app-managed-child choice here, because this app does not
 * supervise its node that way. What the server's choice is to its server, the
 * lifecycle verbs are to this node: state, Start/Stop/Restart with the CLI's
 * pane-safety refusal read out loud before `--force` is offered, Uninstall,
 * and the install-service door for a machine whose node is installed but not
 * supervised. The two bottom-bar reveals are GONE (same ruling: Status's facts
 * already carry the paths, and a reveal bar "feels out of place" under a
 * screen that states a service).
 *
 * Shapes, on the axis the whole screen turns on:
 *
 * - **The node is not installed.** The install offer (with the disabled
 *   no-bundled case) and the refusal that went with it — `no-node` covers two
 *   very different machines and keeping them apart is the whole care here:
 *   nothing answered at all means installing is safe unconfirmed and is
 *   offered on its own rather than folded into Register, because a machine
 *   with no node CLI cannot say whether it is ALREADY a node, and Register's
 *   chain enrols with `confirm: true`. A binary that answered `version` but
 *   not `status --json` gets the mute card and no offer at all: the remedy
 *   for a binary that cannot state its own status is a different binary, and
 *   the probe's own `error` is already on the problem line.
 * - **Enrolled, no service definition.** The install-and-start offer, in the
 *   problem's own words. This is the door a node CLI installed by hand used to
 *   find closed on every state the probe could not name.
 * - **Enrolled, service installed.** The arrangement stated, the run-at-login
 *   switch, the lifecycle verbs, and the manager's own detail when it said
 *   anything.
 */
import type { ReactElement } from "react";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { ActionOutput } from "@/components/assistant/status-facts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { NodeCommands } from "@/hooks/use-node-commands";
import { autostartSupported, MIN_AUTOSTART_NODE_VERSION } from "@/lib/autostart-gate";
import { IS_MACOS, tmuxHint } from "@/lib/copy";
import type { ActionResult, Probe, ProbeStep } from "@/lib/ipc";
import { serviceAction } from "@/lib/node-assistant-state";
import { PROBE_STEPS, paneRisk, stepLabel, stepTone } from "@/lib/steps";

/** A fact's value colour per tone — the badge palette, keyed by the step's own colour. */
const TONE_BADGE: Record<string, "success" | "warning" | "destructive" | "muted"> = {
  ok: "success",
  warn: "warning",
  bad: "destructive",
  neutral: "muted",
};

/**
 * Why the node is not answering — one sentence per step, carried verbatim from
 * the status screen this section split off of (they were this screen's own
 * sentences, written for a card under a heading that named the machine; here
 * the heading names the NODE, and the sentences still carry the consequence).
 */
function serviceProblem(step: ProbeStep): string | null {
  switch (step) {
    case "stopped":
      return "The background service is installed, but the node is not running, so nothing can launch on this machine.";
    case "offline":
      return "The service manager reports the node as running, but no local daemon is heartbeating.";
    case "no-service":
      return "The node is registered, but there is no service for it. It only runs when something starts it by hand.";
    default:
      return null;
  }
}

/** The second sentence — what to DO about it, or what the verb will write. Verbatim from the same split. */
function serviceDetail(step: ProbeStep): string | null {
  switch (step) {
    case "offline":
      return (
        "A node that starts, fails and is restarted on a timer looks exactly like this. Its own log says why: a " +
        "missing tmux, an unreachable control plane, or a node key the server no longer recognises."
      );
    case "no-service":
      return (
        `Running it in the background registers the node with ${IS_MACOS ? "macOS" : "Linux"}, so it starts at ` +
        "login and comes back if it exits."
      );
    default:
      return null;
  }
}

/** The arrangement's own sentence — the server supervision option's words, which are true here too. */
function arrangementBody(): string {
  return "The node runs on this machine, not in this app. If it stops, it is started again.";
}

export function ServiceScreen(props: {
  shell: FrameShell;
  /** The rail node the app computed for this screen, or undefined when the screen is full-window. */
  rail?: ReactElement;
  probe: Probe | undefined;
  commands: NodeCommands;
  busy: boolean;
  /** Start the node registration flow — for a client that is not a node yet. */
  onRegister: () => void;
  /** The CLI's last words — the verbs' answers, rendered inline below. */
  output: ActionResult | null;
}): ReactElement {
  const { shell, probe, commands, busy, onRegister, output } = props;

  const enrolled = Boolean(probe?.status?.nodeId);
  const installed = probe?.service?.installed === true;
  const running = probe?.service?.state === "running";
  /**
   * Which way the run-at-login switch points, with the fallback that keeps
   * older agents honest: `autostart` is the named field, `enabled` is the same
   * fact as every agent has always reported, and `null` (neither answered) is
   * a switch that says so rather than one that guesses.
   */
  const atLogin = probe?.service?.autostart ?? probe?.service?.enabled ?? null;
  /**
   * Whether the resolved agent has the VERB the switch writes with
   * (`service autostart on|off`, 0.15.0+). An older one answers the READ —
   * `enabled` has been reported forever — and would answer the WRITE with a
   * usage error, so the switch shows the state greyed with the update that
   * unlocks it, the server's `autostartSupported` pattern (round two,
   * 2026-09-22).
   */
  const supported = autostartSupported(probe);
  const action = probe ? serviceAction(probe.step) : null;
  const problem = probe ? serviceProblem(probe.step) : null;
  const detail = probe ? serviceDetail(probe.step) : null;
  /** tmux is a gate, not a caption: a service that starts without it 409s every launch. */
  const blocked = probe !== undefined && !probe.tmux;

  const known = probe === undefined || (PROBE_STEPS as readonly string[]).includes(probe.step);
  const mute = probe?.step === "no-node" && probe.nodeBinary != null;
  const noNode = probe?.step === "no-node" && probe.nodeBinary == null;

  return (
    <Frame
      {...shell}
      rail={props.rail}
      tightContent
      // The state chip reads in the header, as the status screen's does
      // (operator ruling 2026-09-22): title, state, then the section.
      badge={<Badge variant={TONE_BADGE[stepTone(probe?.step)]}>{stepLabel(probe?.step)}</Badge>}
      // The two reveals are GONE (operator ruling 2026-09-22): Status's facts
      // already carry the paths, and they "feel out of place" here. The bar
      // is empty, as the status screen's is.
    >
      {probe && !known && (
        <div className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-detail leading-relaxed">
            This app does not recognise the state "{probe.step}", which usually means it is older than the node CLI it
            is managing.
          </p>
        </div>
      )}

      {mute && (
        <div className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-detail leading-relaxed">
            Nothing has been changed. This app will not offer to register a machine whose node CLI cannot say whether it
            is already a node: enrolling overwrites the existing configuration and discards its node key.
          </p>
        </div>
      )}

      {noNode && (
        <div className="mt-6 rounded-md border border-border p-3">
          {/* The explainer is DELETED (operator ruling 2026-09-22, second
              addendum): the button speaks for itself, and the "what is a
              node" half is the section's own subtitle. The card carries a
              title (addendum 3, the operator's exact words): what the button
              does, in the vocabulary the plane uses for the same act. */}
          <p className="font-strong text-detail">Register as a node</p>
          <div className="mt-2">
            {probe?.bundledVersion ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={commands.installNode}>
                Install the Subshell Node CLI
              </Button>
            ) : (
              <p className="text-muted-foreground text-detail">
                This build ships no node CLI, so one has to be installed on this machine some other way.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Enrolled with NO definition: the install-service door. This is the
          offer the server's supervision screen has always made and this side
          had no day-2 door for — the machine whose node CLI is installed but
          unsupervised gets the same act the first run's chain performs.
          Driven by the definition rather than only the step word, so every
          enrolled machine that answers "nothing installed" finds it. */}
      {enrolled && !installed && action && (
        <div className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="font-strong text-detail">In the background</p>
          {problem && <p className="mt-2 text-detail leading-relaxed">{problem}</p>}
          {detail && <p className="mt-2 text-detail text-muted-foreground leading-relaxed">{detail}</p>}
          <div className="mt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || blocked}
              onClick={() => {
                // Install is not one of restart's two-phase paths; `settle`
                // waits for the manager's spawn to take the lock so the
                // screen lands on online rather than on a stale offline.
                commands.service(action.verb, { settle: true });
              }}
            >
              {action.label}
            </Button>
          </div>
          {blocked && <p className="mt-2 text-detail text-warning">{tmuxHint(probe, "service")}</p>}
        </div>
      )}

      {/* Enrolled WITH a definition: the arrangement stated, the run-at-login
          switch under it, the lifecycle verbs. The server's Service section
          states its arrangement as a selected choice with the switch nested
          beneath; a node has one arrangement, so the same pair renders as one
          card rather than a radio answering a question nobody can ask. */}
      {enrolled && installed && (
        <div className="mt-6 rounded-md border border-border p-3">
          <p className="font-strong text-detail">In the background</p>
          <p className="mt-2 text-detail leading-relaxed">{arrangementBody()}</p>
          {problem && <p className="mt-2 text-detail leading-relaxed">{problem}</p>}
          {detail && <p className="mt-2 text-detail text-muted-foreground leading-relaxed">{detail}</p>}

          {/* The switch, nested under the arrangement it belongs to — arming
              login means nothing without a service, which is why this whole
              card only exists when one is installed. It reads the probe and
              writes through `service autostart on|off`, which changes the NEXT
              login and interrupts nothing running, so it is a switch rather
              than a confirmed act. */}
          <div className="mt-3 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Switch
                id="service-autostart"
                checked={atLogin === true}
                disabled={busy || atLogin === null || !supported}
                onCheckedChange={(checked) => commands.autostart(checked)}
              />
              <Label htmlFor="service-autostart">Start the node at login</Label>
            </div>
            <p className="text-detail text-muted-foreground">
              {!supported
                ? `Update your node to ${MIN_AUTOSTART_NODE_VERSION} to change this.`
                : atLogin === null
                  ? "The node CLI did not report whether it starts at login."
                  : atLogin
                    ? "Right now it comes back by itself every time you log in."
                    : "Right now it does not start after a login by itself. Turn this on and it comes back at every login."}
            </p>
          </div>

          {/* The lifecycle verbs. The two that START things are gated on tmux
              like the install above (a node that comes up without it 409s
              every launch); Stop and Uninstall are deliberately NOT: they
              cannot manufacture that failure, and a button that strands the
              box is worse than one missing a gate. Restart is the two-phase
              command: the CLI's refusal is read before `--force` is offered. */}
          <div className="mt-3 flex flex-wrap gap-2">
            {!running && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || blocked}
                onClick={() => commands.service("start", { settle: true })}
              >
                Start
              </Button>
            )}
            {running && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => commands.service("stop", { settle: true })}
              >
                Stop
              </Button>
            )}
            {running && (
              <Button variant="outline" size="sm" disabled={busy || blocked} onClick={commands.restart}>
                Restart
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={busy} onClick={commands.uninstall}>
              Uninstall
            </Button>
          </div>
          {blocked && <p className="mt-2 text-detail text-warning">{tmuxHint(probe, "service")}</p>}
          {/* Where the log lives, on the one state whose cause is only IN the
              log — a crash loop inside its restart window is indistinguishable
              from a healthy start from out here. On Linux this is the
              `journalctl` line, which is the only place a person finds it. */}
          {probe?.step === "offline" && probe.paths?.nodeLogHint && (
            <p className="mt-2 text-detail text-muted-foreground">{probe.paths.nodeLogHint}</p>
          )}
          {/* The manager's own words, verbatim (`launchd: spawn scheduled` is
              the crash-throttle wait, not a plain stop). The facts list on
              Status repeats it; this section owns the service, and a person
              acting HERE reads it HERE. */}
          {probe?.service?.detail && <p className="mt-2 text-detail text-muted-foreground">{probe.service.detail}</p>}
        </div>
      )}

      {/* The pane-safety rewrite door: the restart refusal names it BY LABEL,
          so it stays a card of its own. A definition without `KillMode=process`
          / `AbandonProcessGroup` SIGKILLs every pane on this machine on any
          teardown. */}
      {paneRisk(probe) && (
        <div className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-detail leading-relaxed">
            The installed service definition does not spare live panes, so stopping or restarting the node kills every
            subshell running on this machine.
          </p>
          <div className="mt-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={commands.rewrite}>
              Rewrite the service definition
            </Button>
          </div>
        </div>
      )}

      {/* Register this machine, beside the install offer (operator ruling
          2026-09-22, screenshot 60): the act LEFT the status screen, which
          keeps machine state only, and joined the node's machinery home.
          Same gate as the card it was: offered on a machine the probe has
          read, that is not already a node, and whose step this build knows —
          and NOT on the no-node cases, where the install above comes first
          (Register's chain enrolls with `confirm: true`, so it may not be
          offered over a state this app cannot read). The walk entry and its
          override-clearing wiring are the handler App supplies, unchanged.
          The supplement (same day): the blurb is DELETED — the button speaks
          for itself, as the install card's already does — and the card
          carries the operator's exact-words title, in the one card-title
          style. */}
      {probe !== undefined && !enrolled && known && probe.step !== "no-node" && (
        <div className="mt-6 rounded-md border border-border p-3">
          <p className="font-strong text-detail">Enroll this machine as a node</p>
          <div className="mt-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={onRegister}>
              Register this machine
            </Button>
          </div>
        </div>
      )}

      {/* The verbs' and installs' own words, INLINE — the screen's actions'
          answers, rendered as the output block alone (operator ruling
          2026-09-22, screenshot 60: the FACTS list is Status's alone; a
          fact this section needs to explain a state is its card's own
          sentence). */}
      <ActionOutput output={output} />
    </Frame>
  );
}
