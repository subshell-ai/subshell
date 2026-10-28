import { apiFetch, Button, errMessage } from "@internal/node-admin";
import { useEffect, useId, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";

interface Settings {
  rewriteUrls: boolean;
  passHost: boolean;
  rewriteRedirects: boolean;
}
const options = [
  [
    "rewriteUrls",
    "Rewrite app URLs",
    "Keep root-relative and matching app URLs inside this preview, including live reload connections.",
  ],
  [
    "passHost",
    "Pass the preview host",
    "Send the browser's host to the app. Leave this off if the app only accepts its own hostname.",
  ],
  ["rewriteRedirects", "Rewrite redirects", "Keep redirects to this app inside the preview."],
] as const;
export function PreviewSettingsDialog({
  paneId,
  port,
  serviceId,
  onClose,
  onOpen,
}: {
  paneId: string;
  port: number;
  serviceId?: string;
  onClose: () => void;
  onOpen: () => void | Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const url = `/api/subshells/${encodeURIComponent(paneId)}/views/settings`;
  const target = serviceId ? { serviceId } : { port };
  useEffect(() => {
    let live = true;
    apiFetch<Settings>(url, {
      method: "POST",
      body: JSON.stringify({ target: serviceId ? { serviceId } : { port }, action: "read" }),
    })
      .then((value) => {
        if (live) setSettings(value);
      })
      .catch((err) => {
        if (live) setError(errMessage(err, "Couldn't load preview settings."));
      });
    return () => {
      live = false;
    };
  }, [url, port, serviceId]);
  async function save(action: "save" | "reset") {
    setBusy(true);
    setError(null);
    try {
      const value = await apiFetch<Settings>(url, {
        method: "POST",
        body: JSON.stringify({ target, action, settings: action === "save" ? settings : undefined }),
      });
      setSettings(value);
      await onOpen();
      onClose();
    } catch (err) {
      setError(errMessage(err, "Couldn't save preview settings."));
    } finally {
      setBusy(false);
    }
  }
  const reason = busy ? "Saving and opening this preview…" : !settings ? "Waiting for preview settings…" : undefined;
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure preview</DialogTitle>
          <DialogDescription>
            These settings are just for you. They're saved for this app on this node across subshells and devices.
            Saving opens a fresh preview.
          </DialogDescription>
        </DialogHeader>
        {!settings && !error && <p role="status">Loading preview settings…</p>}
        {error && (
          <p role="alert" className="text-destructive text-detail">
            {error}
          </p>
        )}
        {settings && (
          <FieldGroup>
            {options.map(([key, label, description]) => (
              <Field key={key}>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-${key}`}
                    checked={settings[key]}
                    disabled={busy}
                    onCheckedChange={(checked) => setSettings({ ...settings, [key]: checked })}
                  />
                  <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
                </div>
                <p className="text-detail text-muted-foreground">{description}</p>
              </Field>
            ))}
          </FieldGroup>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={!!reason} disabledReason={reason} onClick={() => void save("reset")}>
            Reset to defaults
          </Button>
          <Button variant="outline" disabled={busy} disabledReason={busy ? reason : undefined} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!!reason} disabledReason={reason} onClick={() => void save("save")}>
            Save and open
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
