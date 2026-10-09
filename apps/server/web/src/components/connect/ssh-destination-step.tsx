import { Button } from "@internal/node-admin";
import { DestinationField } from "@/components/connect/destination-field";
import { buildDestinationOptions } from "@/components/connect/destination-options";
import type { SshSessionDraft } from "@/components/connect/ssh-session-draft";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useSshAliases, useSshSavedHosts } from "@/hooks/use-ssh";

/** Reuses the click-dismiss destination picker and its canonical suggestion state. */
export function SshDestinationStep({
  draft,
  onChange,
  nodeName,
  ready,
}: {
  draft: SshSessionDraft;
  onChange: (draft: SshSessionDraft) => void;
  nodeName?: string;
  ready: boolean;
}) {
  const ledger = useSshSavedHosts();
  const aliases = useSshAliases(ready ? draft.nodeId : null);
  const { options, candidates } = buildDestinationOptions({
    saved: ledger.data?.saved ?? [],
    recent: ledger.data?.recent ?? [],
    aliases: aliases.data?.aliases ?? [],
    machineName: nodeName ?? null,
    typed: draft.destination.typed,
  });
  const label = options.find((option) => option.value === draft.destination.pickId)?.label;
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="ssh-wizard-destination">SSH destination</FieldLabel>
        <DestinationField
          id="ssh-wizard-destination"
          placeholder="user@hostname:22 or an SSH alias"
          typed={draft.destination.typed}
          query={draft.destination.pick && label === draft.destination.typed ? "" : draft.destination.typed}
          options={options}
          onTextChange={(typed) => onChange({ ...draft, destination: { typed, pick: null, pickId: null } })}
          onPick={(option) => {
            const pick = candidates.get(option.value);
            if (pick) onChange({ ...draft, destination: { pick, pickId: option.value, typed: option.label } });
          }}
        />
        <p className="text-detail text-muted-foreground">
          Enter the destination you want to access, for example deploy@example.com:22, or choose a saved destination.
        </p>
        {(ledger.isError || aliases.isError) && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-destructive text-detail">
              {ledger.isError && "Saved and recent destinations could not be read. "}
              {aliases.isError && "SSH config aliases could not be read. "}
              You can still type a destination.
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={ledger.isFetching || aliases.isFetching}
              onClick={() => {
                if (ledger.isError) void ledger.refetch();
                if (aliases.isError) void aliases.refetch();
              }}
            >
              Retry destination suggestions
            </Button>
          </div>
        )}
      </Field>
    </FieldGroup>
  );
}
