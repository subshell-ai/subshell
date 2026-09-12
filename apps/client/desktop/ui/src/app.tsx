/**
 * Subshell Client's bundled page — the `node` window, as an assistant.
 *
 * NOT the app's only window. `main` shows a control plane's own UI, loaded
 * from the plane's own origin and granted no commands at all; this page is the
 * other half, and the only surface that drives the `subshell` CLI.
 *
 * It used to be seven stacked cards that showed everything at once and asked
 * nothing in particular. It is now one screen at a time, each asking exactly
 * one question, in the same frame Subshell Server's setup assistant uses, so
 * the two apps read as one product (spec 2026-09-12 § 6.4). The facts moved
 * under Show Details rather than a permanent status card, because a person
 * opens this window to DO something.
 *
 * There is no platform branch anywhere in here: one word for where you are, on
 * both platforms (operator's call, 2026-09-12) — see `node-assistant-state.ts`.
 * A genuine platform FACT still has one, such as which tmux installer to name.
 *
 * This file is the HOST and nothing else: it reads the machine
 * (`use-node-state`), holds the action runner and the enroll form, asks
 * `screenFor` which screen the machine implies, and composes the shared half
 * of the frame — title, subtitle, the problem line, the confirmation and the
 * footer. Each screen owns its own icon, content and bottom bar.
 */
import { useState } from "react";
import { AboutFooter } from "@/components/about-footer";
import { ConnectScreen } from "@/components/assistant/connect-screen";
import { ConnectedScreen } from "@/components/assistant/connected-screen";
import { EnrollScreen } from "@/components/assistant/enroll-screen";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { InstallAgentScreen } from "@/components/assistant/install-agent-screen";
import { ResetScreen } from "@/components/assistant/reset-screen";
import { ServiceScreen } from "@/components/assistant/service-screen";
import { subtitleFor } from "@/components/assistant/subtitles";
import { ConfirmPanel } from "@/components/confirm-panel";
import { Button } from "@/components/ui/button";
import { useActionRunner } from "@/hooks/use-action-runner";
import { useEnrollForm } from "@/hooks/use-enroll-form";
import { useNodeCommands } from "@/hooks/use-node-commands";
import { useNodeState } from "@/hooks/use-node-state";
import type { EnrolledNodeBody } from "@/lib/ipc";
import { type NodeUserScreen, screenFor, screenTitle } from "@/lib/node-assistant-state";

export function App() {
  const runner = useActionRunner();
  const { probe, settings, firstProbePending, readError } = useNodeState(runner.busy);
  const form = useEnrollForm();

  /** A screen the USER chose rather than one the machine implies. */
  const [override, setOverride] = useState<NodeUserScreen | null>(null);
  /**
   * The `enroll --json` body from a successful enrollment in THIS session —
   * the only place the node's display NAME is knowable, since `status --json`
   * reports no name and `config.json`'s is not among the facts Rust hands out.
   */
  const [enrolledNode, setEnrolledNode] = useState<EnrolledNodeBody | null>(null);

  const commands = useNodeCommands({
    runner,
    probe,
    form,
    onEnrolled: (node) => {
      setEnrolledNode(node);
      setOverride(null);
    },
  });

  const screen = screenFor(probe, settings, override);

  /**
   * The action's own refusal answers what was clicked, so it outranks a probe
   * failure, which is background weather. That precedence is the fix for a
   * defect this page had to preserve through two rewrites: a re-probe must
   * never be able to replace the message an action just produced.
   */
  const problem = runner.failure || readError || probe?.error || "";

  const shell: FrameShell = {
    title: screen ? screenTitle(screen, probe) : "Checking This Machine",
    subtitle: screen ? subtitleFor(screen, probe, settings) : undefined,
    problem,
    confirm: runner.pending ? (
      <ConfirmPanel pending={runner.pending} busy={runner.busy} onAccept={runner.accept} onCancel={runner.cancel} />
    ) : undefined,
    footer: <AboutFooter probe={probe} />,
  };

  if (screen === null) {
    // Nothing read yet, or the probe itself could not be read. The second is
    // not a state to sit in silently: `problem` names it and Retry is the one
    // thing that can change it.
    const failed = !firstProbePending && probe === undefined;
    return (
      <Frame
        {...shell}
        subtitle={failed ? undefined : "Reading this machine's agent, service and configuration."}
        barRight={
          failed ? (
            <Button className="min-w-[120px]" disabled={runner.busy} onClick={commands.refresh}>
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  }

  const facts = { probe, settings, enrolledNode, output: runner.output };

  switch (screen) {
    case "connect":
      return <ConnectScreen shell={shell} commands={commands} busy={runner.busy} />;
    case "install-agent":
      return <InstallAgentScreen shell={shell} {...facts} commands={commands} busy={runner.busy} />;
    case "enroll":
      return (
        <EnrollScreen
          shell={shell}
          {...facts}
          form={form}
          commands={commands}
          busy={runner.busy}
          onCancel={
            override === "enroll"
              ? () => {
                  if (runner.busy) return;
                  form.clearErrors();
                  setOverride(null);
                }
              : undefined
          }
        />
      );
    case "service":
      return (
        <ServiceScreen
          shell={shell}
          {...facts}
          commands={commands}
          busy={runner.busy}
          onReset={() => setOverride("reset")}
        />
      );
    case "connected":
      return (
        <ConnectedScreen
          shell={shell}
          {...facts}
          commands={commands}
          busy={runner.busy}
          onReenroll={() => {
            if (runner.busy) return;
            form.seedServer(probe?.status?.serverUrl ?? settings?.planeUrl ?? "");
            setOverride("enroll");
          }}
          onReset={() => setOverride("reset")}
        />
      );
    case "reset":
      return (
        <ResetScreen shell={shell} {...facts} runner={runner} busy={runner.busy} onCancel={() => setOverride(null)} />
      );
  }
}
