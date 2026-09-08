/**
 * Subshell Client's bundled page — the `node` window.
 *
 * NOT the app's only window. `main` shows a control plane's own UI, loaded from
 * the plane's own origin and granted no commands at all; this page is the other
 * half, and the only surface that drives the `subshell` CLI. Its sentence:
 * paste a server URL and a setup key, and this machine becomes a node that
 * agents can be launched on, without ever meeting the CLI.
 *
 * The composition behind that — `hooks/use-node-state` reads the machine,
 * `hooks/use-node-commands` acts on it, `components/step-screens` holds the
 * words, and this decides which of them is on screen — plus
 * `components/plane-card`, which is the door to the other window.
 *
 * There is no router: one page and a step machine. The step is the probe's own
 * `step`, except while the user has explicitly asked for a screen the machine's
 * state does not imply — today only re-enrolment.
 */
import { useState } from "react";
import { OutputBlock } from "@/components/output-block";
import { PlaneCard } from "@/components/plane-card";
import { PrefsCard } from "@/components/prefs-card";
import { StatusCard } from "@/components/status-card";
import { StepCard } from "@/components/step-card";
import { useActionRunner } from "@/hooks/use-action-runner";
import { useEnrollForm } from "@/hooks/use-enroll-form";
import { useNodeCommands } from "@/hooks/use-node-commands";
import { useNodeState } from "@/hooks/use-node-state";
import type { EnrolledNodeBody } from "@/lib/ipc";
import type { StepKey, UserStep } from "@/lib/steps";

export function App() {
  const runner = useActionRunner();
  const { probe, settings, firstProbePending, readError, recheckSettings, settingsFetching } = useNodeState(
    runner.busy,
  );
  const form = useEnrollForm();

  /**
   * A step the USER chose rather than one the machine implies. Cleared as soon
   * as the flow moves on.
   */
  const [override, setOverride] = useState<UserStep | null>(null);
  /**
   * The `enroll --json` body from a successful enrollment in THIS session.
   *
   * The only place the node's display NAME is knowable: `status --json` reports
   * `nodeId`/`serverUrl`/`online` and no name, and `config.json`'s name is not
   * among the facts the Rust side is willing to hand out. So the name is shown
   * when this app just chose it and is silently absent otherwise, rather than
   * being guessed at from the hostname — which is a default, not a fact.
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

  const step: StepKey | null = override ?? probe?.step ?? null;

  /**
   * The action's own refusal answers what was clicked, so it outranks a probe
   * failure, which is background weather. That precedence is the fix for the
   * defect this rewrite had to preserve: a re-probe must never be able to
   * replace the message an action just produced.
   */
  const problem = runner.failure || readError || probe?.error || "";

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-3 px-6 pt-5 pb-7">
      <header>
        <h1 className="font-semibold text-[15px] tracking-tight">Subshell Client</h1>
        <p className="mt-0.5 text-muted-foreground text-xs">
          Watch a Subshell control plane, and register this machine with it as a node.
        </p>
      </header>

      <PlaneCard
        settings={settings}
        busy={runner.busy}
        onOpen={commands.openPlane}
        onOpenBrowser={commands.openPlaneUrl}
      />

      <StatusCard
        probe={probe}
        settings={settings}
        enrolledNode={enrolledNode}
        busy={runner.busy}
        firstProbePending={firstProbePending}
        onRefresh={commands.refresh}
      />

      <StepCard
        step={step}
        context={{
          probe,
          settings,
          commands,
          probeFailed: !firstProbePending && probe === undefined,
          onShowEnroll: () => {
            if (runner.busy) return;
            form.seedServer(probe?.status?.serverUrl ?? "");
            setOverride("enroll");
          },
          onCancelEnroll: () => {
            if (runner.busy) return;
            form.clearErrors();
            setOverride(null);
          },
        }}
        form={form}
        busy={runner.busy}
        problem={problem}
        pending={runner.pending}
        onAccept={runner.accept}
        onCancel={runner.cancel}
      />

      <PrefsCard
        settings={settings}
        busy={runner.busy}
        rechecking={settingsFetching}
        onCloseToTrayChange={commands.setCloseToTray}
        onRecheckTray={recheckSettings}
      />

      <OutputBlock result={runner.output} />
    </main>
  );
}
