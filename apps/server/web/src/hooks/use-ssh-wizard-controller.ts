import { useEffect, useMemo, useState } from "react";
import {
  type SshSessionDraft,
  type SshWizardIntent,
  type SshWizardStep,
  sshDestination,
  sshKeySelectionProblem,
  sshWizardSteps,
} from "@/components/connect/ssh-session-draft";
import type { SshWizardProps } from "@/components/connect/ssh-wizard";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useSshNodeRoster } from "@/hooks/use-ssh";
import { useSshEnrollment } from "@/hooks/use-ssh-enrollment";
import { makeForm, useSubmitDisabled } from "@/lib/form";
import { canAddNode } from "@/lib/node-enrollment";

/** Adaptive navigation and validation outlive every individual step, including enrollment. */
export function useSshWizardController({
  intent: initialIntent,
  draft,
  onDraftChange,
  machines,
  readiness,
  onStart,
  busy,
  launchBlocked,
}: SshWizardProps) {
  const [intent, setIntent] = useState<SshWizardIntent | null>(initialIntent ?? null);
  const [current, setCurrent] = useState<SshWizardStep>(
    initialIntent === "connect" ? "destination" : initialIntent ? "machine" : "intent",
  );
  const [adding, setAdding] = useState(false);
  const enrollment = useSshEnrollment();
  const { data: settings } = usePublicSettings();
  const mayAdd = canAddNode(settings);
  const machine = machines.find((m) => m.node.id === draft.nodeId);
  const keyMachine = machines.find((m) => m.node.id === draft.keyHome);
  const remote = !!draft.keyHome && draft.keyHome !== draft.nodeId;
  const fingerprints = draft.selections[draft.keyHome] ?? [];
  const roster = useSshNodeRoster(
    intent !== "prepare" && remote && keyMachine?.canConnect && ["keys", "review", "readiness"].includes(current)
      ? draft.keyHome
      : null,
  );
  const steps = sshWizardSteps(intent, draft, machines, current, adding);
  const index = Math.max(0, steps.indexOf(current));
  const values = useMemo(() => ({ draft, current }), [draft, current]);
  function problems(value: typeof values): Record<string, string> {
    if (value.current === "destination" && !sshDestination(value.draft)) return { draft: "Enter an SSH destination." };
    if (["machine", "review", "readiness"].includes(value.current) && !value.draft.nodeId)
      return { draft: "Choose a machine." };
    if (value.current === "key-source" && (!value.draft.keyHome || value.draft.keyHome === value.draft.nodeId))
      return { draft: "Choose another machine for keys." };
    if (
      intent !== "prepare" &&
      ["keys", "review", "readiness"].includes(value.current) &&
      value.draft.keyHome &&
      value.draft.keyHome !== value.draft.nodeId
    ) {
      const problem = sshKeySelectionProblem(value.draft.selections[value.draft.keyHome] ?? []);
      if (problem) return { draft: problem };
    }
    if (value.current === "review" && !sshDestination(value.draft)) return { draft: "Enter an SSH destination." };
    return {};
  }
  function lifecycleBlocked(): boolean {
    if (
      readiness.isPending ||
      readiness.isError ||
      busy ||
      enrollment.create.isPending ||
      (current === "review" && launchBlocked)
    )
      return true;
    if (current === "enrollment")
      return !enrollment.consumedNodeId || !machines.some((m) => m.node.id === enrollment.consumedNodeId);
    if (current === "machine") return !machine;
    if (["machine-setup", "review", "readiness"].includes(current) && !machine?.canConnect) return true;
    if (current === "key-source" && !keyMachine) return true;
    if (current === "key-setup" && !keyMachine?.canConnect) return true;
    if (intent !== "prepare" && ["keys", "review", "readiness"].includes(current) && remote)
      return (
        !keyMachine?.canConnect ||
        roster.isPending ||
        roster.isError ||
        sshKeySelectionProblem(fingerprints, roster.data?.identities) !== null
      );
    return false;
  }
  async function next(): Promise<void> {
    if (Object.keys(problems(values)).length > 0 || lifecycleBlocked()) return;
    if (current === "review") {
      await onStart();
      return;
    }
    if (current === "enrollment" && enrollment.consumedNodeId) {
      onDraftChange({ ...draft, nodeId: enrollment.consumedNodeId });
      setCurrent("machine-setup");
      return;
    }
    setCurrent(steps[index + 1] ?? "readiness");
  }
  const form = makeForm({
    defaultValues: { value: values },
    validator: ({ value }): Record<string, string> => {
      const error = Object.values(problems(value))[0];
      return error ? { value: error } : {};
    },
    onSubmit: next,
  });
  useEffect(() => {
    form.setFieldValue("value", values);
    void form.validate("change");
  }, [values, form]);
  const disabled = useSubmitDisabled(form, lifecycleBlocked());
  const selectIntent = (value: SshWizardIntent) => {
    setIntent(value);
    setCurrent(value === "connect" ? "destination" : "machine");
  };
  const patch = (value: Partial<SshSessionDraft>) => onDraftChange({ ...draft, ...value });
  const chooseKeys = (id: string) =>
    patch({ keyHome: id, selections: { ...draft.selections, [id]: draft.selections[id] ?? [] } });
  return {
    intent,
    current,
    setCurrent,
    setAdding,
    enrollment,
    mayAdd,
    machine,
    keyMachine,
    remote,
    fingerprints,
    roster,
    steps,
    index,
    form,
    disabled,
    selectIntent,
    patch,
    chooseKeys,
  };
}
