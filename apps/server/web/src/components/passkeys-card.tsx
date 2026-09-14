import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, errMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { passkeysSupported } from "@/lib/webauthn";

/** A registered passkey as returned by better-auth's list endpoint. */
interface PasskeyRow {
  /** Delete handle */
  id: string;
  /** User-supplied label */
  name?: string | null;
  /** ISO 8601 registration time (unused; kept honest with the payload) */
  createdAt?: string;
}

/**
 * Self-service passkeys (spec 2026-08-31 §4): every signed-in user manages
 * their OWN credentials here. The WebAuthn ceremony (add) goes through the
 * better-auth client plugin — challenge encoding is its job. The plain JSON
 * list/delete endpoints stay on apiFetch, matching every other same-origin
 * read in the app.
 */
export function PasskeysCard() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const {
    data: passkeys,
    isError: listError,
    refetch,
  } = useQuery({
    queryKey: ["passkeys"],
    queryFn: () => apiFetch<PasskeyRow[]>("/api/auth/passkey/list-user-passkeys"),
  });

  async function addPasskey() {
    setBusy(true);
    setError(null);
    try {
      const { error: addErr } = await authClient.passkey.addPasskey(name.trim() ? { name: name.trim() } : {});
      if (addErr) {
        const code = (addErr as unknown as { code?: string }).code;
        if (code !== "REGISTRATION_CANCELLED") setError(addErr.message ?? "Couldn't register the passkey");
        return;
      }
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await apiFetch("/api/auth/passkey/delete-passkey", { method: "POST", body: JSON.stringify({ id }) });
      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    } catch (err) {
      setError(errMessage(err, "Couldn't delete the passkey."));
    }
  }

  const supported = passkeysSupported();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        <CardDescription>
          Sign in without a password. A passkey belongs to one device and to the address this instance serves from. From
          a different address (e.g. localhost vs the domain) your passkeys won&apos;t be found.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* The LIST stays either way: passkeys registered from a browser are
          still this account's, and still worth being able to remove from
          here. Only registration needs an authenticator this engine lacks. */}
        {supported ? (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-2">
              <Label htmlFor="passkey-name">Passkey name</Label>
              <Input
                id="passkey-name"
                value={name}
                placeholder="e.g. MacBook Touch ID"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button onClick={() => void addPasskey()} disabled={busy}>
              {busy ? "Waiting for device…" : "Add passkey"}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            This app can&apos;t register passkeys: its browser engine has no authenticator. Add one from a browser on
            this device; it will work here for signing in.
          </p>
        )}
        {listError ? (
          <ErrorBanner
            message="Couldn't load passkeys."
            className="rounded-md border"
            action={
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-detail text-inherit underline"
                onClick={() => void refetch()}
              >
                Retry
              </Button>
            }
          />
        ) : (passkeys?.length ?? 0) === 0 ? (
          <p className="text-muted-foreground text-sm">No passkeys yet.</p>
        ) : (
          <ul className="space-y-1">
            {passkeys?.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{p.name || "Unnamed passkey"}</span>
                <Button variant="ghost" size="sm" onClick={() => void remove(p.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </CardContent>
    </Card>
  );
}
