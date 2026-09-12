/**
 * Start the Node Service — the screen for a registered machine whose agent is
 * not answering.
 *
 * One decision, and which one is the step's to name: `serviceAction` maps
 * `no-service` → Install and Start, `stopped` → Start, `offline` → Restart. A
 * step this build predates lands here too, with no verb and a Retry, because
 * this is the screen that shows the facts and the last output — the two things
 * that make an unrecognised state diagnosable.
 *
 * The card page's other teardown buttons (Stop, Uninstall) are deliberately
 * not here. Spec 2026-09-12 § 6.4 gives this screen one decision; restarting a
 * node is now also reachable from the control plane itself (§ 6.3), and
 * removing the service altogether is what Reset does. What survives is the one
 * REMEDY the restart refusal names by label — rewriting a definition that
 * would take live panes down — because the confirmation text points at it.
 */
import { Terminal } from "lucide-react";
import { DetailsDisclosure } from "@/components/assistant/details-disclosure";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { Button } from "@/components/ui/button";
import type { NodeCommands } from "@/hooks/use-node-commands";
import { tmuxHint } from "@/lib/copy";
import type { ActionResult, EnrolledNodeBody, NodeSettings, Probe } from "@/lib/ipc";
import { serviceAction } from "@/lib/node-assistant-state";
import { paneRisk } from "@/lib/steps";

export function ServiceScreen(props: {
  shell: FrameShell;
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  enrolledNode: EnrolledNodeBody | null;
  output: ActionResult | null;
  commands: NodeCommands;
  busy: boolean;
  onReset: () => void;
}) {
  const { shell, probe, settings, enrolledNode, output, commands, busy, onReset } = props;
  const action = probe ? serviceAction(probe.step) : null;
  const hint = probe?.step === "offline" ? (probe.paths?.agentLogHint ?? "") : tmuxHint(probe, "service");
  const blocked = probe !== undefined && !probe.tmux;

  return (
    <Frame
      {...shell}
      icon={<Terminal />}
      barLeft={
        <>
          {/*
           * Re-reading is not a decision, which is why it sits with the
           * ghosts: this is the screen someone waits on while they fix the
           * machine from a terminal, and the 5 s poll is too slow to feel like
           * an answer to "I just installed tmux".
           */}
          <Button variant="ghost" disabled={busy} onClick={commands.refresh}>
            Refresh
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => commands.openPath("config-dir")}>
            Reveal configuration
          </Button>
          {/*
           * Offered on every platform even though Linux has no log FILE: the
           * Rust side rejects with the `journalctl` command to run instead,
           * which is the actionable answer and the only place a user would
           * find it.
           */}
          <Button variant="ghost" disabled={busy} onClick={() => commands.openPath("agent-log")}>
            Open the agent log
          </Button>
        </>
      }
      barRight={
        action ? (
          <Button
            className="min-w-[120px]"
            disabled={busy || blocked}
            onClick={() => {
              // `restart` has its own two-phase path: the CLI's refusal is read
              // out loud before `--force` is offered as a separate button.
              if (action.verb === "restart") commands.restart();
              else commands.service(action.verb, { settle: true });
            }}
          >
            {action.label}
          </Button>
        ) : (
          <Button className="min-w-[120px]" disabled={busy} onClick={commands.refresh}>
            Retry
          </Button>
        )
      }
    >
      {probe?.step === "offline" && (
        <p className="text-muted-foreground text-sm leading-relaxed">
          An agent that starts, fails and is restarted on a timer looks exactly like this. Its own log says why: a
          missing tmux, an unreachable control plane, or a node key the server no longer recognises.
        </p>
      )}
      {probe?.step === "no-service" && (
        <p className="text-muted-foreground text-sm leading-relaxed">
          Running it in the background writes a user-level service definition (a systemd user unit on Linux, a launchd
          agent on macOS) that starts the agent at login and brings it back if it exits.
        </p>
      )}
      {hint && <p className="mt-3 text-warning text-xs leading-relaxed">{hint}</p>}
      {/*
       * The one remedy that survived the card page's action row, and it is
       * here rather than in the bar because the restart refusal names it BY
       * LABEL: "the button labelled Rewrite the service definition is the
       * CLI's own first suggestion". A definition without `KillMode=process` /
       * `AbandonProcessGroup` SIGKILLs every pane on this machine on any
       * teardown, so it is worth a sentence, not just a button.
       */}
      {paneRisk(probe) && (
        <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-xs leading-relaxed">
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
      <DetailsDisclosure probe={probe} settings={settings} enrolledNode={enrolledNode} output={output} />
      <p className="mt-6">
        <button
          type="button"
          className="rounded-sm text-muted-foreground text-xs underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={onReset}
          disabled={busy}
        >
          Reset Subshell…
        </button>
      </p>
    </Frame>
  );
}
