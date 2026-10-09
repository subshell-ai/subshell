import { Button, errMessage } from "@internal/node-admin";
import { sshKeySelectionProblem } from "@/components/connect/ssh-session-draft";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useSshNodeRoster } from "@/hooks/use-ssh";

export const SSH_AGENT_ACCESS_COPY =
  "The Subshell process on this machine needs access to SSH_AUTH_SOCK. An interactive shell’s SSH agent may differ from the agent available to its background service.";

/** Only mounted on the explicit remote-key path. No roster entry is selected implicitly. */
export function SshKeyStep({
  nodeId,
  fingerprints,
  onChange,
}: {
  nodeId: string | null;
  fingerprints: string[];
  onChange: (values: string[]) => void;
}) {
  const roster = useSshNodeRoster(nodeId);
  const problem = sshKeySelectionProblem(fingerprints, roster.data?.identities);
  if (!nodeId)
    return (
      <p role="status" className="text-detail text-muted-foreground">
        The selected key machine is unavailable. Bring it online with SSH enabled, or choose another machine.
      </p>
    );
  return (
    <FieldGroup>
      <p className="text-detail text-muted-foreground">Choose the keys to use. Private keys stay on the key machine.</p>
      {roster.isPending && (
        <p role="status" className="text-detail text-muted-foreground">
          Loading SSH agent keys…
        </p>
      )}
      {roster.isError && (
        <div role="alert" className="flex flex-col gap-2">
          <p className="text-destructive text-detail">
            Could not read this machine’s SSH agent: {errMessage(roster.error, "The agent could not be reached.")}
          </p>
          <p className="text-detail text-muted-foreground">{SSH_AGENT_ACCESS_COPY}</p>
        </div>
      )}
      {roster.data && (
        <fieldset className="flex flex-col gap-3">
          <legend className="font-strong text-label">SSH agent keys</legend>
          {roster.data.identities.map((key, index) => (
            <Field key={key.fingerprint}>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`ssh-wizard-key-${index}`}
                  checked={fingerprints.includes(key.fingerprint)}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked ? [...fingerprints, key.fingerprint] : fingerprints.filter((f) => f !== key.fingerprint),
                    )
                  }
                />
                <FieldLabel htmlFor={`ssh-wizard-key-${index}`}>{key.comment || key.fingerprint}</FieldLabel>
              </div>
              <p className="break-all font-mono text-detail text-muted-foreground">{key.fingerprint}</p>
            </Field>
          ))}
          {roster.data.identities.length === 0 && (
            <p className="text-detail text-muted-foreground">
              No keys are loaded in this machine’s SSH agent. Load the keys you want to use into that agent, then Retry
              keys.
            </p>
          )}
        </fieldset>
      )}
      {problem && !roster.isError && (
        <p role="status" className="text-detail text-muted-foreground">
          {problem}
        </p>
      )}
      <Button type="button" variant="outline" className="self-start" onClick={() => void roster.refetch()}>
        Retry keys
      </Button>
    </FieldGroup>
  );
}
