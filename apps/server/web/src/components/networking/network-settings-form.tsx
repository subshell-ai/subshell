import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { NetworkSettingsError, type NetworkSettingsIssue, useUpdateNetworkSettings } from "@/hooks/use-network";
import { errMessage } from "@/lib/api";
import type { NetworkRow, SettingsFieldWire } from "@/types/network";

/**
 * Whether the server holds a value for a secret field.
 *
 * A secret's value NEVER comes back — the list sends `{ set }` in its place —
 * so "Set" and "Not set" is the whole of what this form may know, and the
 * input beside it replaces rather than edits. Anything else here would be a
 * form echoing a credential back onto a screen.
 */
function secretIsSet(row: NetworkRow, key: string): boolean {
  const value = row.settings[key];
  return typeof value === "object" && value !== null ? value.set : false;
}

/** The saved value of a non-secret field, as text the input can hold. */
function savedValue(row: NetworkRow, field: SettingsFieldWire): string {
  const value = row.settings[field.key];
  if (typeof value === "string") return value;
  // Never the stored value for a secret (there is none here), and the
  // declared default for a field the instance has never written.
  return field.default === undefined || typeof field.default === "object" ? "" : String(field.default);
}

/** Whether a boolean field currently reads true. */
function savedBoolean(row: NetworkRow, field: SettingsFieldWire): boolean {
  const value = row.settings[field.key];
  if (typeof value === "string") return value === "true";
  return field.default === true;
}

/**
 * The plugin's own settings, above the acts they change.
 *
 * Above rather than below on purpose: these are what the act will be
 * performed WITH — an auth key, a hostname, a region — so a person reads them
 * before pressing the thing that uses them.
 *
 * Two rules the form keeps, both borrowed from `AddressesCard` because they
 * are the same two problems:
 *
 * - **Drafts seed from saved only while untouched**, so a poll landing
 *   underneath an edit never overwrites it. This list polls in seconds while
 *   an act is in flight, which is exactly when someone is typing into it.
 * - **A refusal lands under the field it names.** The route answers 400 with
 *   `issues: [{ field, message }]`, and a settings form with four inputs
 *   whose complaint appears at the bottom leaves the reader to guess which
 *   one it is about.
 */
export function NetworkSettingsForm({
  row,
  disabled = false,
  onPendingChange,
  reason,
  requiredOnly = false,
}: {
  /** The network whose settings these are */
  row: NetworkRow;
  /** True while an act is in flight on this row */
  disabled?: boolean;
  /**
   * Reports this form's own save as it starts and finishes.
   *
   * The card gates every OTHER act on "is anything happening to this row", and
   * this mutation is the one it cannot see for itself. Without this a publish
   * could start on top of a settings write, which is the staleness the route
   * refuses anyway — the two gates are supposed to agree.
   */
  onPendingChange?: (pending: boolean) => void;
  /**
   * Why the fields are disabled, when the reason is worth stating.
   *
   * A form disabled while an act runs explains itself — the act is on screen.
   * A form disabled because the SERVER would refuse the write does not, and
   * leaving that unsaid puts the explanation after the edit instead of in
   * front of it.
   */
  reason?: string;
  /**
   * Render only the fields the plugin marks `required`.
   *
   * The first-run step asks the shortest question that can still succeed: an
   * optional field there is a decision nobody has the context to make yet,
   * and the full form lives one page away under Settings. A REQUIRED field
   * cannot be dropped the same way — hiding it would leave a Connect button
   * that refuses with no way on screen to satisfy it.
   */
  requiredOnly?: boolean;
}) {
  const fields = requiredOnly ? row.settingsFields.filter((field) => field.required) : row.settingsFields;
  const reasonId = `network-${row.id}-settings-reason`;
  /** Points a disabled field at the sentence explaining why. */
  const describedBy = reason ? { "aria-describedby": reasonId } : {};
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const update = useUpdateNetworkSettings();
  const touched = Object.keys(drafts);
  const issues: NetworkSettingsIssue[] = update.error instanceof NetworkSettingsError ? update.error.issues : [];
  const issueFor = (key: string) => issues.find((issue) => issue.field === key)?.message;
  // A form-level failure is one that named no field: a 403, an unreadable
  // config, a network that went. Anything naming a field is already rendered
  // under it, and saying it twice reads as two problems.
  const formFailure =
    update.error && issues.length === 0 ? errMessage(update.error, "The settings were not saved.") : null;

  const set = (key: string, value: string) => setDrafts((prev) => ({ ...prev, [key]: value }));

  // Mirrored upward on every change of the flag, never inside `save`: a
  // mutation that settles through an error path would otherwise leave the
  // card believing a write is still running.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the callback is the subscriber, not a dependency of the value
  useEffect(() => {
    onPendingChange?.(update.isPending);
  }, [update.isPending]);

  function save(): void {
    update.mutate(
      { id: row.id, settings: drafts },
      // The answer is the list refetch, which re-seeds every field from what
      // the server stored — including anything it canonicalized on the way in.
      { onSuccess: () => setDrafts({}) },
    );
  }

  if (fields.length === 0) return null;

  return (
    <div className="space-y-4">
      {/* Associated with every field, not merely placed above them. A screen
          reader tabbing this form skips disabled inputs entirely, so a bare
          paragraph is a reason the people most likely to be confused by the
          disabled state never reach. */}
      {reason && (
        <p id={reasonId} className="text-detail text-muted-foreground">
          {reason}
        </p>
      )}
      {fields.map((field) => {
        const id = `network-${row.id}-${field.key}`;
        const problem = issueFor(field.key);
        return (
          <div key={field.key} className="space-y-1.5">
            <Label htmlFor={id}>
              {field.label}
              {field.required && <span className="ml-1 text-detail text-muted-foreground">(required)</span>}
            </Label>
            {field.type === "boolean" ? (
              <Switch
                id={id}
                aria-label={field.label}
                {...describedBy}
                checked={drafts[field.key] !== undefined ? drafts[field.key] === "true" : savedBoolean(row, field)}
                disabled={disabled || update.isPending}
                onCheckedChange={(checked) => set(field.key, checked ? "true" : "false")}
              />
            ) : field.type === "select" ? (
              <Select
                value={drafts[field.key] ?? savedValue(row, field)}
                onValueChange={(value) => value !== null && set(field.key, String(value))}
                disabled={disabled || update.isPending}
              >
                <SelectTrigger id={id} aria-label={field.label} {...describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(field.choices ?? []).map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {choice}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : field.type === "secret" ? (
              <div className="space-y-1.5">
                <p className="text-detail text-muted-foreground">
                  {secretIsSet(row, field.key) ? "Set" : "Not set"}
                  {secretIsSet(row, field.key) && " — typing here replaces it."}
                </p>
                <Input
                  id={id}
                  type="password"
                  autoComplete="off"
                  {...describedBy}
                  placeholder={field.placeholder}
                  value={drafts[field.key] ?? ""}
                  disabled={disabled || update.isPending}
                  onChange={(event) => set(field.key, event.target.value)}
                />
              </div>
            ) : (
              <Input
                id={id}
                type={field.type === "number" ? "number" : "text"}
                placeholder={field.placeholder}
                {...describedBy}
                value={drafts[field.key] ?? savedValue(row, field)}
                disabled={disabled || update.isPending}
                onChange={(event) => set(field.key, event.target.value)}
              />
            )}
            {field.description && <p className="text-detail text-muted-foreground">{field.description}</p>}
            {/* The standing caveat on every secret this form writes, under
                the plugin's own description and never instead of it: the
                plugin says what this secret IS, the page says what this
                server does not do with it.

                It is the SERVER's fact, which is why no manifest has to carry
                it — `subshell-server backup` snapshots the DATABASE, and a
                plugin secret does not live there. An operator who restores a
                backup and finds their tunnel down learns nothing from the
                restore about what is missing, so it is said at the moment the
                secret is entered, where it is cheap, rather than at the
                moment it is discovered, where it is not. */}
            {field.type === "secret" && (
              <p className="text-detail text-muted-foreground">
                <code className="font-mono">subshell-server backup</code> does not include it — after a restore, paste
                it again.
              </p>
            )}
            {problem && <p className="text-destructive text-detail">{problem}</p>}
          </div>
        );
      })}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || touched.length === 0 || update.isPending}
          onClick={save}
        >
          {update.isPending ? "Saving…" : "Save settings"}
        </Button>
        {update.isSuccess && touched.length === 0 && <span className="text-detail text-success">saved</span>}
      </div>
      {formFailure && <p className="text-destructive text-detail">{formFailure}</p>}
    </div>
  );
}
