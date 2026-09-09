import { normalizeLabel } from "@internal/subshell-protocol";
import { useQueryClient } from "@tanstack/react-query";
import { type JSX, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PUBLIC_SETTINGS_QUERY_KEY, usePublicSettings } from "@/hooks/use-public-settings";
import { apiFetch } from "@/lib/api";
import { INSTANCE_NAME_MAX } from "@/lib/name-limits";

/**
 * This instance's name — what every signed-in user sees the control plane
 * called, and what the sign-in page says you are authenticating against.
 *
 * It exists for the person pointing a client at a laptop, a homelab box and a
 * production plane, who otherwise has nothing on screen saying which is which.
 *
 * Blank restores the default (this host's own name) rather than storing an
 * empty label — the server resolves an unset value on every read, so there is
 * no such thing as a nameless instance.
 */
export function InstanceNameCard(): JSX.Element {
  const { data: settings } = usePublicSettings();
  const queryClient = useQueryClient();
  const [value, setValue] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Seed from the server once it answers, and only while the field is
  // untouched — a load settling mid-edit must not overwrite what was typed.
  useEffect(() => {
    if (value === null && settings?.instanceName !== undefined) setValue(settings.instanceName);
  }, [settings?.instanceName, value]);

  const current = value ?? "";
  const cleaned = normalizeLabel(current, INSTANCE_NAME_MAX);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await apiFetch<{ instanceName: string }>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ instanceName: current }),
      });
      // The server is the authority on what "blank" resolved to, so the field
      // is re-seeded from its answer rather than from what was typed.
      setValue(next.instanceName);
      setSaved(true);
      // The sidebar reads this payload on every route; without the
      // invalidation the new name would not appear until the staleTime lapsed.
      await queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
    } catch {
      setError("Couldn't save the instance name.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Instance name</CardTitle>
        <CardDescription>
          Names this control plane for everyone who signs in — in the sidebar, and on the sign-in page before anyone
          authenticates. Set it when you run more than one instance, so a laptop and a production plane are tellable
          apart. Applies at once; no restart.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="instance-name">Name</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="instance-name"
            value={current}
            maxLength={INSTANCE_NAME_MAX}
            placeholder={settings?.instanceName ?? ""}
            disabled={busy || value === null}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            className="w-64"
          />
          <Button variant="outline" size="sm" onClick={() => void save()} disabled={busy || value === null}>
            Save
          </Button>
          {saved && <span className="text-success text-xs">saved</span>}
        </div>
        {!cleaned && (
          <p className="text-muted-foreground text-xs">Blank restores the default: this host&apos;s name.</p>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </CardContent>
    </Card>
  );
}
