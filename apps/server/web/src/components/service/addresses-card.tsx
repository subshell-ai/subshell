import { useState } from "react";
import { RestartDialog } from "@/components/service/restart-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUpdateServerConfig } from "@/hooks/use-server-deployment";
import type { ServerRestart } from "@/hooks/use-server-restart";
import { errMessage } from "@/lib/api";
import type { ServerConfigPatch, ServerDeployment, ServerSettingKey } from "@/types/server-deployment";

/** The four editable keys, in the order the card lays them out. */
const FIELDS = [
  { key: "SERVER_PORT", id: "server-port", label: "Port" },
  { key: "HOST", id: "server-host", label: "Bind address" },
  { key: "APP_BASE_URL", id: "server-base-url", label: "Public base URL" },
  { key: "TRUSTED_ORIGINS", id: "server-trusted-origins", label: "Other addresses browsers will use" },
] as const satisfies readonly { key: ServerSettingKey; id: string; label: string }[];

/** The keys this card may write. `DATABASE_PATH` is deliberately not one of them. */
type EditableKey = (typeof FIELDS)[number]["key"];

/**
 * One key's contribution to the PATCH body — the SPA's spelling of the key on
 * the left, the value in the shape the route wants on the right.
 */
function patchFor(key: EditableKey, value: string): ServerConfigPatch {
  switch (key) {
    case "SERVER_PORT":
      return { port: Number(value) };
    case "HOST":
      return { host: value };
    case "APP_BASE_URL":
      return { baseUrl: value };
    case "TRUSTED_ORIGINS":
      return {
        trustedOrigins: value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      };
  }
}

/** How a key's saved value is shown in its field. */
function displayValue(key: EditableKey, saved: string): string {
  // Stored as one line; shown comma-separated because that is how a person
  // types a short list into a single field.
  return key === "TRUSTED_ORIGINS"
    ? saved
        .split(/[,\s]+/)
        .filter(Boolean)
        .join(", ")
    : saved;
}

/**
 * Where this server listens and which addresses a browser may use (spec
 * 2026-09-12 § 4.2).
 *
 * Two rules hold the card together. Fields are seeded from `saved` **only
 * while untouched** — an edit in progress is never overwritten by a poll
 * landing underneath it, which is the same rule `InstanceNameCard` follows
 * and for the same reason. And the strip above the form is driven by the
 * VIEW's `restartRequired`, not by whether this card just saved: someone who
 * edited config.env over ssh gets the same sentence without the SPA having
 * written anything.
 */
export function AddressesCard({ view, restart }: { view: ServerDeployment; restart: ServerRestart }) {
  const [drafts, setDrafts] = useState<Partial<Record<EditableKey, string>>>({});
  const [confirming, setConfirming] = useState(false);
  const update = useUpdateServerConfig();
  const touched = Object.keys(drafts) as EditableKey[];

  function save(): void {
    const patch = touched.reduce<ServerConfigPatch>(
      (body, key) => Object.assign(body, patchFor(key, drafts[key] ?? "")),
      {},
    );
    update.mutate(patch, {
      // The answer is the fresh view and it is already in the cache, so
      // dropping the drafts re-seeds every field from what the server stored
      // — including anything it canonicalized on the way in.
      onSuccess: () => setDrafts({}),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Addresses</CardTitle>
        <CardDescription>
          Where this server listens, and which addresses a browser is allowed to reach it from. Saved to the config
          file; a restart is what applies them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.restartRequired && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/50 px-3 py-2 text-sm text-warning">
            <span>Saved. Restart the server to apply.</span>
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              Restart
            </Button>
          </div>
        )}

        {FIELDS.map(({ key, id, label }) => {
          const setting = view.settings[key];
          const fromEnv = setting.source === "process env";
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={id}>{label}</Label>
              <Input
                id={id}
                value={drafts[key] ?? displayValue(key, setting.saved)}
                readOnly={fromEnv}
                disabled={update.isPending}
                className={fromEnv ? "text-muted-foreground" : undefined}
                onChange={(event) => setDrafts((prev) => ({ ...prev, [key]: event.target.value }))}
              />
              {fromEnv && (
                <p className="text-muted-foreground text-xs">Set by the environment ({key}); change it there.</p>
              )}
              {key === "APP_BASE_URL" && (
                <p className="text-muted-foreground text-xs">Changing this moves where passkeys work.</p>
              )}
              {setting.saved !== setting.running && (
                <p className="text-warning text-xs">
                  Saved {setting.saved || "(blank)"} · running {setting.running || "(blank)"}
                </p>
              )}
              {setting.problems?.map((problem) => (
                <p key={problem.entry} className="text-destructive text-xs">
                  {problem.entry}: {problem.reason}
                </p>
              ))}
            </div>
          );
        })}

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" disabled={touched.length === 0 || update.isPending} onClick={save}>
            Save
          </Button>
          {update.isSuccess && touched.length === 0 && <span className="text-success text-xs">saved</span>}
        </div>

        {update.error && (
          <p className="text-destructive text-sm">
            {errMessage(update.error, "The configuration could not be saved.")}
          </p>
        )}
        {update.data?.warnings.map((warning) => (
          <p key={warning} className="text-sm text-warning">
            {warning}
          </p>
        ))}
      </CardContent>
      <RestartDialog
        open={confirming}
        onOpenChange={setConfirming}
        view={view}
        onConfirm={(force) => {
          setConfirming(false);
          void restart.restart(force ? { force: true } : {});
        }}
      />
    </Card>
  );
}
