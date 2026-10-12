import { useEffect, useMemo, useState } from "react";
import {
  type SshSessionDraft,
  type SshWizardIntent,
  type SshWizardStep,
  sshDestination,
  sshKeySelectionProblem,
  sshKeySourceProblem,
  sshWizardSteps,
} from "@/components/connect/ssh-session-draft";
import type { SshWizardProps } from "@/components/connect/ssh-wizard";
import { useSshNodeRoster } from "@/hooks/use-ssh";
import { makeForm, useSubmitDisabled } from "@/lib/form";

/** Adaptive navigation and validation outlive every individual step, including readiness updates. */
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
  const machine = machines.find((m) => m.node.id === draft.nodeId);
  const keyMachine = machines.find((m) => m.node.id === draft.keyHome);
  const remote = !!draft.keyHome;
  const keySourceProblem = sshKeySourceProblem(draft);
  const fingerprints = draft.selections[draft.keyHome] ?? [];
  const roster = useSshNodeRoster(
    intent !== "prepare" &&
      remote &&
      !keySourceProblem &&
      keyMachine?.canConnect &&
      ["keys", "review", "readiness"].includes(current)
      ? draft.keyHome
      : null,
  );
  const steps = sshWizardSteps(intent, draft, current);
  const index = Math.max(0, steps.indexOf(current));
  const values = useMemo(() => ({ draft, current }), [draft, current]);
  function problems(value: typeof values): Record<string, string> {
    if (value.current === "destination" && !sshDestination(value.draft)) return { draft: "Enter an SSH destination." };
    if (["machine", "review", "readiness"].includes(value.current) && !value.draft.nodeId)
      return { draft: "Choose a machine." };
    if (intent !== "prepare" && ["key-source", "keys", "review", "readiness"].includes(value.current)) {
      const problem = sshKeySourceProblem(value.draft);
      if (problem) return { draft: problem };
    }
    if (value.current === "key-source" && !value.draft.keyHome) return { draft: "Choose another machine for keys." };
    if (intent !== "prepare" && ["keys", "review", "readiness"].includes(value.current) && value.draft.keyHome) {
      const problem = sshKeySelectionProblem(value.draft.selections[value.draft.keyHome] ?? []);
      if (problem) return { draft: problem };
    }
    if (value.current === "review" && !sshDestination(value.draft)) return { draft: "Enter an SSH destination." };
    return {};
  }
  function lifecycleBlocked(): boolean {
    if (readiness.isPending || readiness.isError || busy || (current === "review" && launchBlocked)) return true;
    if (current === "machine") return !machine?.canConnect;
    if (["review", "readiness"].includes(current) && !machine?.canConnect) return true;
    if (current === "key-source" && !keyMachine?.canConnect) return true;
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
    machine,
    keyMachine,
    keySourceProblem,
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
