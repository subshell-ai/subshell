import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Switch } from "@internal/node-admin";
import { BACKUP_RESTORE_DEFAULTS } from "@internal/subshell-protocol";
import { useStore } from "@tanstack/react-form";
import { useState } from "react";
import { ErrorBanner } from "@/components/error-banner";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useBackupDownload } from "@/hooks/use-backups";
import { type FieldProblems, fieldError, makeForm, useSubmitDisabled } from "@/lib/form";

type BackupDraft = { encrypted: boolean; password: string; confirmation: string };
function backupProblems(draft: BackupDraft): FieldProblems {
  if (!draft.encrypted) return {};
  const problems: FieldProblems = {};
  if (!draft.password || draft.password.length > 4096)
    problems.password = "Enter an encryption password of 1–4096 characters.";
  if (!draft.confirmation || draft.password !== draft.confirmation) problems.confirmation = "Passwords do not match.";
  return problems;
}

export function CreateBackupCard() {
  const backup = useBackupDownload();
  const busy = backup.create.isPending || backup.job.data?.status === "creating";
  const error = backup.create.error ?? backup.job.error ?? backup.cancel.error;
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const form = makeForm({
    defaultValues: { encrypted: BACKUP_RESTORE_DEFAULTS.encrypt as boolean, password: "", confirmation: "" },
    validator: backupProblems,
    onSubmit: (draft) => {
      if (busy || Object.keys(backupProblems(draft)).length > 0) return;
      backup.create.mutate(draft.encrypted ? draft.password : undefined, {
        onSuccess: () => {
          form.setFieldValue("password", "");
          form.setFieldValue("confirmation", "");
        },
      });
    },
  });
  const encrypted = useStore(form.store, (state) => state.values.encrypted);
  const disabled = useSubmitDisabled(form, busy);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create backup</CardTitle>
        <CardDescription>
          Download one archive containing the database, settings, identities, plugins, secrets, and server logs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-detail text-muted-foreground">
          Projects, project uploads, remote node files, external agent credentials, and operating system services stay
          on their machines. Backups contain secrets; keep your archive somewhere private.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
          className="space-y-4"
        >
          <FieldGroup>
            <Field className="flex-row items-center justify-between">
              <FieldLabel htmlFor="backup-encrypt">Encrypt with a password</FieldLabel>
              <Switch
                id="backup-encrypt"
                checked={encrypted}
                onCheckedChange={(value) => form.setFieldValue("encrypted", value)}
                disabled={busy}
              />
            </Field>
            {encrypted && (
              <>
                <form.Field name="password">
                  {(field) => {
                    const problem =
                      field.state.meta.isTouched && focusedField !== "password"
                        ? fieldError(field.state.meta.errors)
                        : null;
                    return (
                      <Field data-invalid={!!problem}>
                        <FieldLabel htmlFor="backup-password">Encryption password</FieldLabel>
                        <Input
                          id="backup-password"
                          type="password"
                          autoComplete="new-password"
                          required
                          value={field.state.value}
                          onChange={(event) => field.handleChange(event.target.value)}
                          onFocus={() => setFocusedField("password")}
                          onBlur={() => {
                            field.handleBlur();
                            setFocusedField(null);
                          }}
                          aria-invalid={!!problem}
                          maxLength={4096}
                          disabled={busy}
                        />
                        {problem && (
                          <p role="alert" className="text-destructive text-detail">
                            {problem}
                          </p>
                        )}
                      </Field>
                    );
                  }}
                </form.Field>
                <form.Field name="confirmation">
                  {(field) => {
                    const problem =
                      field.state.meta.isTouched && focusedField !== "confirmation"
                        ? fieldError(field.state.meta.errors)
                        : null;
                    return (
                      <Field data-invalid={!!problem}>
                        <FieldLabel htmlFor="backup-confirm">Confirm password</FieldLabel>
                        <Input
                          id="backup-confirm"
                          type="password"
                          autoComplete="new-password"
                          required
                          value={field.state.value}
                          onChange={(event) => field.handleChange(event.target.value)}
                          onFocus={() => setFocusedField("confirmation")}
                          onBlur={() => {
                            field.handleBlur();
                            setFocusedField(null);
                          }}
                          aria-invalid={!!problem}
                          maxLength={4096}
                          disabled={busy}
                        />
                        {problem && (
                          <p role="alert" className="text-destructive text-detail">
                            {problem}
                          </p>
                        )}
                      </Field>
                    );
                  }}
                </form.Field>
                <p className="text-detail text-muted-foreground">
                  Store this password separately. A forgotten encryption password cannot be recovered.
                </p>
              </>
            )}
          </FieldGroup>
          {error && <ErrorBanner message={error.message} className="rounded-md border" />}
          {backup.job.data?.error && <ErrorBanner message={backup.job.data.error} className="rounded-md border" />}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={disabled}>
              {busy ? "Creating backup…" : "Create backup"}
            </Button>
            {backup.jobId && (
              <Button
                type="button"
                variant="outline"
                onClick={() => backup.cancel.mutate()}
                disabled={backup.cancel.isPending}
              >
                Discard download
              </Button>
            )}
            {backup.job.data?.status === "ready" && backup.downloadUrl && (
              <a href={backup.downloadUrl} download className="text-body underline">
                Download {backup.job.data.filename}
              </a>
            )}
          </div>
          {backup.job.data?.status === "ready" && (
            <p className="text-detail text-muted-foreground">
              This download is available once, for one hour. The server deletes its temporary copy after the download.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
