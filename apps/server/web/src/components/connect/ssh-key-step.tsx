import { Button, errMessage, FormSectionTitle } from "@internal/node-admin";
import { sshKeySelectionProblem } from "@/components/connect/ssh-session-draft";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useSshNodeRoster } from "@/hooks/use-ssh";

export const SSH_AGENT_ACCESS_COPY =
  "Subshell needs access to the SSH agent that holds your keys. Set SSH_AUTH_SOCK for the Subshell service; keys available in your terminal may not be available to that service.";

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
        The machine supplying your keys is unavailable. Bring it online and enable SSH in Subshell, or choose another
        machine.
      </p>
    );
  return (
    <FieldGroup>
      <p className="text-detail text-muted-foreground">
        Choose which keys this connection can use. The private keys stay on the machine supplying them.
      </p>
      {roster.isPending && (
        <p role="status" className="text-detail text-muted-foreground">
          Loading SSH agent keys…
        </p>
      )}
      {roster.isError && (
        <div role="alert" className="flex flex-col gap-2">
          <p className="text-destructive text-detail">
            Couldn’t load SSH keys from this machine: {errMessage(roster.error, "Its SSH agent could not be reached.")}
          </p>
          <p className="text-detail text-muted-foreground">{SSH_AGENT_ACCESS_COPY}</p>
        </div>
      )}
      {roster.data && (
        <fieldset className="flex flex-col gap-3">
          <FormSectionTitle as="legend" className="mb-3">
            SSH agent keys
          </FormSectionTitle>
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
          {fingerprints
            .filter((fingerprint) => !roster.data.identities.some((key) => key.fingerprint === fingerprint))
            .map((fingerprint) => (
              <div key={fingerprint} className="flex flex-col items-start gap-2">
                <p className="break-all font-mono text-detail text-muted-foreground">{fingerprint}</p>
                <p className="text-detail text-muted-foreground">
                  This key is no longer loaded in the machine’s SSH agent.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Remove unavailable key ${fingerprint}`}
                  onClick={() => onChange(fingerprints.filter((selected) => selected !== fingerprint))}
                >
                  Remove unavailable key
                </Button>
              </div>
            ))}
          {roster.data.identities.length === 0 && (
            <p className="text-detail text-muted-foreground">
              No keys are loaded in this machine’s SSH agent. Load the keys you want to use, then reload this list.
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
        Reload keys
      </Button>
    </FieldGroup>
  );
}
