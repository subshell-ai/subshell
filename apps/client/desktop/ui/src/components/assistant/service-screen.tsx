/**
 * Service — the rail section that carries the node's own machinery (operator
 * ruling 2026-09-22, live screenshot: "a section called Service and that's
 * where the node install would be if it is not installed"). What moved out of
 * the status screen, and why: the status screen keeps MACHINE state — what
 * this machine is, whether subshells can run on it, what its dashboard is —
 * while the node's install, its service lifecycle and its own log are the
 * machinery a Service section is FOR.
 *
 * Two shapes, on the axis the whole screen turns on:
 *
 * - **The node is not installed.** The install offer (with the disabled
 *   no-bundled case) and the refusal that went with it — `no-node` covers two
 *   very different machines and keeping them apart is the whole care here:
 *   nothing answered at all means installing is safe unconfirmed and is
 *   offered on its own rather than folded into Register, because a machine
 *   with no node CLI cannot say whether it is ALREADY a node, and Register's
 *   chain enrolls with `confirm: true`. A binary that answered `version` but
 *   not `status --json` gets the mute card and no offer at all: the remedy
 *   for a binary that cannot state its own status is a different binary, and
 *   the probe's own `error` is already on the problem line.
 * - **The node is installed.** The contextual service verb, the pane-safety
 *   rewrite door, and the two reveals (the node's config directory and log —
 *   the node's machinery, not the machine's).
 */
import type { ReactElement } from "react";
import { StatusFacts } from "@/components/assistant/details-disclosure";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { NodeCommands } from "@/hooks/use-node-commands";
import { tmuxHint } from "@/lib/copy";
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
      return "This machine is registered, but nothing keeps the node running.";
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
        "Running it in the background writes a user-level service definition (a systemd user unit on Linux, a " +
        "launchd agent on macOS) that starts the node at login and brings it back if it exits."
      );
    default:
      return null;
  }
}

export function ServiceScreen(props: {
  shell: FrameShell;
  /** The rail node the app computed for this screen, or undefined when the screen is full-window. */
  rail?: ReactElement;
  probe: Probe | undefined;
  commands: NodeCommands;
  busy: boolean;
  /** The CLI's last words — the verbs' answers, rendered inline below. */
  output: ActionResult | null;
}): ReactElement {
  const { shell, probe, commands, busy, output } = props;

  const enrolled = Boolean(probe?.status?.nodeId);
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
      icon={enrolled ? undefined : undefined}
      barLeft={
        // The two reveals are the NODE's config directory and log — the
        // machinery this section is for — and they follow the node rather
        // than the screen: a machine with no node has neither, so offering
        // them there would be two buttons whose only outcome is the Rust
        // side's refusal. The log one is offered on every platform even
        // though Linux has no log FILE: the rejection IS the `journalctl`
        // command to run, which is the actionable answer. There is no
        // Refresh beside them: the probe query re-reads the machine on its
        // own five-second interval, so the poll is the refresh.
        enrolled ? (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => commands.openPath("config-dir")}>
              Reveal configuration
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => commands.openPath("node-log")}>
              Open the node log
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <Badge variant={TONE_BADGE[stepTone(probe?.step)]}>{stepLabel(probe?.step)}</Badge>
      </div>

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
          {/* The trimmed explainer (operator ruling 2026-09-22, "lengthy as
              heck"): what it does and what it does not. The "what is a node"
              half is the section's own subtitle now. */}
          <p className="text-detail leading-relaxed">
            This copies the node this app ships to ~/.local/bin/subshell. Nothing is downloaded.
          </p>
          {probe?.bundledVersion ? (
            <div className="mt-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={commands.installNode}>
                Install the node
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-muted-foreground text-detail">
              This build ships no node CLI, so one has to be installed on this machine some other way.
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
          {/* Where the log lives, on the one state whose cause is only IN the
              log — a crash loop inside its restart window is indistinguishable
              from a healthy start from out here. On Linux this is the
              `journalctl` line, which is the only place a person finds it. */}
          {probe?.step === "offline" && probe.paths?.nodeLogHint && (
            <p className="mt-2 text-detail text-muted-foreground">{probe.paths.nodeLogHint}</p>
          )}
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

      {/* The facts and the CLI's last words, INLINE (the same ruling the
          status screen carries): the verbs' answers are this section's own
          answers, and an output block behind a disclosure would be the
          two-navigations defect again. The ONLY facts list that carries
          `bundled` and `tmux` (operator ruling 2026-09-22) — they are the
          node's machinery. */}
      <StatusFacts probe={probe} settings={undefined} enrolledNode={null} output={output} binaryFacts />
    </Frame>
  );
}
