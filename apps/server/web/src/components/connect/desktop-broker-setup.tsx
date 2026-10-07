import { Button, errMessage, Input } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { sshRuntimeFetch } from "@/lib/ssh-runtime";

export const DESKTOP_BROKERS_QUERY_KEY = ["ssh-desktop-brokers"] as const;
export interface DesktopBroker {
  id: string;
  name: string;
  online: boolean;
}
export function useDesktopBrokers() {
  return useQuery({
    queryKey: DESKTOP_BROKERS_QUERY_KEY,
    queryFn: () => sshRuntimeFetch<{ brokers: DesktopBroker[] }>("/api/ssh-runtime/desktop-brokers"),
    refetchInterval: 5000,
  });
}

/** Pairing is personal and explicitly performed in the trusted native node window. */
export function DesktopBrokerSetup() {
  const brokers = useDesktopBrokers();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [copyError, setCopyError] = useState(false);
  const pair = useMutation({
    mutationFn: (id?: string) =>
      sshRuntimeFetch<{ id: string; name: string; pairingToken: string; expiresAt: string }>(
        "/api/ssh-runtime/desktop-brokers",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim() || brokers.data?.brokers.find((broker) => broker.id === id)?.name || "This computer",
            ...(id ? { id } : {}),
          }),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: DESKTOP_BROKERS_QUERY_KEY });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      sshRuntimeFetch(`/api/ssh-runtime/desktop-brokers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      pair.reset();
      void client.invalidateQueries({ queryKey: DESKTOP_BROKERS_QUERY_KEY });
    },
  });
  useEffect(() => {
    if (!pair.data) return;
    if (brokers.data?.brokers.some((broker) => broker.id === pair.data?.id && broker.online)) {
      pair.reset();
      return;
    }
    const expiry = setTimeout(() => pair.reset(), Math.max(0, new Date(pair.data.expiresAt).getTime() - Date.now()));
    return () => clearTimeout(expiry);
  }, [pair.data, brokers.data, pair.reset]);
  return (
    <section className="flex flex-col gap-3" aria-label="Connect this computer">
      <h2 className="font-strong text-heading">Connect this computer</h2>
      <p className="text-detail text-muted-foreground">
        Use your computer’s SSH settings and keys through Subshell Client. Add your computer below, then open SSH
        Connections → Connect this computer in the app to pair it. You only need to pair once; your SSH keys stay on
        your computer.
      </p>
      <Field>
        <FieldLabel htmlFor="ssh-computer-name">Computer name (optional)</FieldLabel>
        <Input
          id="ssh-computer-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My laptop"
          maxLength={100}
        />
        <p className="text-detail text-muted-foreground">
          Give your computer a name you’ll recognize when connecting. Leave this blank to use “This computer”.
        </p>
      </Field>
      <Button
        variant="outline"
        onClick={() => {
          setCopyError(false);
          pair.mutate(undefined);
        }}
        disabled={pair.isPending}
      >
        Add computer
      </Button>
      {pair.data && (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          <p className="text-detail">
            In Subshell Client, choose SSH Connections → Connect this computer and enter this server URL and pairing
            code. Only paste the code into Subshell Client.
          </p>
          <code className="break-all text-detail">{window.location.origin}</code>
          <code className="break-all text-detail">{pair.data.pairingToken}</code>
          <p className="text-detail text-muted-foreground">
            This code expires at {new Date(pair.data.expiresAt).toLocaleTimeString()}. You can create a new one if
            needed.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(pair.data?.pairingToken ?? "").catch(() => setCopyError(true));
            }}
          >
            Copy pairing code
          </Button>
          {copyError && (
            <p role="alert" className="text-detail">
              We couldn’t copy the code. You can select and copy it from above.
            </p>
          )}
        </div>
      )}
      {(pair.isError || revoke.isError || brokers.isError) && (
        <p role="alert" className="text-destructive text-detail">
          {errMessage(pair.error ?? revoke.error ?? brokers.error, "The connection could not be updated.")}
        </p>
      )}
      {brokers.data?.brokers.map((broker) => (
        <div key={broker.id} className="flex flex-wrap items-center gap-2">
          <span className="flex-1 text-label">
            {broker.name} · {broker.online ? "online" : "offline"}
          </span>
          <Button variant="outline" size="sm" disabled={pair.isPending} onClick={() => pair.mutate(broker.id)}>
            Pair again
          </Button>
          <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(broker.id)}>
            Revoke access
          </Button>
        </div>
      ))}
    </section>
  );
}
