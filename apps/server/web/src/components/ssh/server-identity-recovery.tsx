import {
  apiFetch,
  apiPost,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyableValue,
  errMessage,
  NODE_QUERY_KEY,
  NODES_QUERY_KEY,
} from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { makeForm, useSubmitDisabled } from "@/lib/form";

type IdentityPair = { signing: string; encryption: string };
type IdentityInspection = { own: IdentityPair; registered: IdentityPair | null; matches: boolean };
const IDENTITY_QUERY_KEY = ["server-ssh-identity"] as const;

/** Admin recovery stays reachable when normal node detail refuses an identity mismatch. It never changes peer pins. */
export function ServerIdentityRecovery() {
  const { data: settings } = usePublicSettings();
  const client = useQueryClient();
  const identity = useQuery({
    queryKey: IDENTITY_QUERY_KEY,
    queryFn: () => apiFetch<IdentityInspection>("/api/nodes/local/ssh-identity"),
    enabled: settings?.viewerIsAdmin === true,
  });
  const repair = useMutation({
    mutationFn: (verified: IdentityPair) => apiPost("/api/nodes/local/ssh-identity/repair", verified),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY }),
        client.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, "local"] }),
        client.invalidateQueries({ queryKey: NODES_QUERY_KEY }),
        client.invalidateQueries({ queryKey: ["ssh-readiness"] }),
      ]);
    },
  });
  const form = makeForm({
    defaultValues: { verified: false },
    validator: ({ verified }): Record<string, string> =>
      verified ? {} : { verified: "Verify both disk fingerprints before repairing registration." },
    onSubmit: async ({ verified }) => {
      if (!verified || !identity.data || identity.data.matches || repair.isPending) return;
      try {
        await repair.mutateAsync(identity.data.own);
      } catch {
        /* The mutation's refusal remains inline; 409 can be retried. */
      }
    },
  });
  const disabled = useSubmitDisabled(
    form,
    identity.isPending || identity.isError || !identity.data || identity.data.matches || repair.isPending,
  );
  const _signing = identity.data?.own.signing;
  const _encryption = identity.data?.own.encryption;
  useEffect(() => {
    form.setFieldValue("verified", false);
  }, [form]);
  if (settings?.viewerIsAdmin !== true || (identity.data?.matches && !repair.isSuccess)) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Server SSH identity recovery</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <p className="text-detail text-muted-foreground">
            Compare the disk fingerprints with the server’s identity file through a trusted channel. Repair deliberately
            replaces the registered identity and closes existing SSH relays involving this server. Each peer keeps its
            saved pins until its owner verifies and repairs them separately.
          </p>
          {identity.isPending && (
            <p role="status" className="text-detail">
              Reading server SSH identity…
            </p>
          )}
          {identity.isError && (
            <p role="alert" className="text-destructive text-detail">
              {errMessage(identity.error, "The identity could not be inspected.")} A corrupt identity must be restored
              from a valid backup before registration can be repaired.
            </p>
          )}
          {identity.data && !identity.data.matches && (
            <>
              <p className="text-detail">The identity on disk does not match the server’s registered identity.</p>
              <IdentityFacts label="Identity on disk" pair={identity.data.own} />
              <IdentityFacts label="Registered identity" pair={identity.data.registered} />
              <form.Field name="verified">
                {(field) => (
                  <Field>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="ssh-identity-verified"
                        checked={field.state.value}
                        onCheckedChange={(checked) => field.handleChange(checked === true)}
                      />
                      <FieldLabel htmlFor="ssh-identity-verified">
                        I verified both disk fingerprints through a trusted channel
                      </FieldLabel>
                    </div>
                  </Field>
                )}
              </form.Field>
              <Button type="button" disabled={disabled} onClick={() => void form.handleSubmit()}>
                {repair.isPending ? "Repairing server identity registration…" : "Repair server identity registration"}
              </Button>
            </>
          )}
          {repair.isError && (
            <p role="alert" className="text-destructive text-detail">
              {errMessage(repair.error, "Registration repair did not finish.")} Retry after reading the current
              fingerprints again.
            </p>
          )}
          {repair.isSuccess && (
            <p role="status" className="text-detail">
              Server identity registration repaired. Peer pins were not changed.
            </p>
          )}
          <Button type="button" variant="outline" disabled={repair.isPending} onClick={() => void identity.refetch()}>
            Retry identity inspection
          </Button>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

function IdentityFacts({ label, pair }: { label: string; pair: IdentityPair | null }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-strong text-label">{label}</h3>
      {pair ? (
        <>
          <CopyableValue value={pair.signing} label={`${label} signing fingerprint`} />
          <CopyableValue value={pair.encryption} label={`${label} encryption fingerprint`} />
        </>
      ) : (
        <p className="text-detail text-muted-foreground">No registered identity.</p>
      )}
    </div>
  );
}
