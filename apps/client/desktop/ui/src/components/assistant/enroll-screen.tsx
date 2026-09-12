/**
 * Enroll This Machine — the one screen that spends a credential.
 *
 * Reached two ways, and they are not the same question. From the probe
 * (`not-enrolled`) it is the next thing that has to be true; from the connected
 * screen's More… it is a re-enrolment, which overwrites `config.json`, mints a
 * SECOND node row on the control plane and discards the current node key whose
 * only copy is that file. The second case says all of that before the button,
 * and offers Cancel — which is what `onCancel` being defined means.
 *
 * The tmux gate is a hard stop rather than a hint: `subshell enroll` preflights
 * tmux BEFORE its network call precisely so an unenrollable box does not burn a
 * one-time setup key, so the button is disabled and the amber sentence explains
 * it. A button that only ever produces a refusal teaches people to click
 * through warnings.
 */
import { KeyRound } from "lucide-react";
import { DetailsDisclosure } from "@/components/assistant/details-disclosure";
import { Frame, type FrameShell } from "@/components/assistant/frame";
import { EnrollFields } from "@/components/enroll-fields";
import { Button } from "@/components/ui/button";
import type { EnrollForm } from "@/hooks/use-enroll-form";
import type { NodeCommands } from "@/hooks/use-node-commands";
import { ENROLL_NOTES, tmuxHint } from "@/lib/copy";
import type { ActionResult, EnrolledNodeBody, NodeSettings, Probe } from "@/lib/ipc";

export function EnrollScreen(props: {
  shell: FrameShell;
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  enrolledNode: EnrolledNodeBody | null;
  output: ActionResult | null;
  form: EnrollForm;
  commands: NodeCommands;
  busy: boolean;
  /** Defined only when the user asked for this screen — a re-enrolment. */
  onCancel?: () => void;
}) {
  const { shell, probe, settings, enrolledNode, output, form, commands, busy, onCancel } = props;
  const reenroll = onCancel !== undefined;
  const current = probe?.status?.nodeId;
  const where = probe?.status?.serverUrl;
  const hint = tmuxHint(probe, "enroll");
  // `probe === undefined` is "not read yet": the buttons stay live then,
  // because the first probe landing is what reveals whether the gate applies.
  const blocked = probe !== undefined && !probe.tmux;

  const notes = reenroll
    ? [
        current
          ? `This machine is already enrolled as node ${current}${where ? ` on ${where}` : ""}. Enrolling again ` +
            "overwrites that configuration, registers a SECOND node on the control plane, and discards the current " +
            "node key, whose only copy is that file. The old node row stays behind and has to be deleted by hand."
          : "This machine already has a node configuration. Enrolling again replaces it.",
        ...ENROLL_NOTES,
      ]
    : ENROLL_NOTES;

  return (
    <Frame
      {...shell}
      icon={<KeyRound />}
      barLeft={
        onCancel && (
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )
      }
      barRight={
        <Button
          className="min-w-[120px]"
          variant={reenroll ? "destructive" : "default"}
          disabled={busy || blocked}
          onClick={commands.enroll}
        >
          Enroll
        </Button>
      }
    >
      <div className="mx-auto w-[360px]">
        <EnrollFields form={form} busy={busy} />
      </div>
      <div className="mt-6">
        {notes.map((note) => (
          <p key={note} className="mt-2 text-muted-foreground text-xs leading-relaxed">
            {note}
          </p>
        ))}
        {hint && <p className="mt-3 text-warning text-xs leading-relaxed">{hint}</p>}
      </div>
      {/*
       * The CLI's own words matter MOST here: an enrolment that failed after
       * the control plane accepted the key has spent it, and `subshell
       * enroll`'s stderr is what says whether to mint a new one. It is the
       * reason this screen carries the disclosure at all.
       */}
      <DetailsDisclosure probe={probe} settings={settings} enrolledNode={enrolledNode} output={output} />
    </Frame>
  );
}
