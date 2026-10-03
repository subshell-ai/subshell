import { Button, Input, Switch } from "@internal/node-admin";
import {
  BACKUP_PASSWORD_GUIDANCE,
  BACKUP_RESTORE_DEFAULTS,
  backupEncryptionPasswordProblem,
} from "@internal/subshell-protocol";
import { useStore } from "@tanstack/react-form";
import { useEffect, useState } from "react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useBackupDownload } from "@/hooks/use-backups";
import { type FieldProblems, fieldError, makeForm, useSubmitDisabled } from "@/lib/form";
import { BackupError, BackupFacts, BackupProgress, BackupWorkflow } from "./backup-workflow";

type BackupDraft = { encrypted: boolean; password: string; confirmation: string };
function backupProblems(draft: BackupDraft): FieldProblems {
  if (!draft.encrypted) return {};
  const problems: FieldProblems = {};
  const passwordProblem = backupEncryptionPasswordProblem(draft.password);
  if (passwordProblem) problems.password = passwordProblem;
  if (!draft.confirmation || draft.password !== draft.confirmation) problems.confirmation = "Passwords do not match.";
  return problems;
}

export function CreateBackupCard({ onBusy }: { onBusy?: (busy: boolean) => void }) {
  const [step, setStep] = useState<"configure" | "progress" | "complete">("configure");
  const [archiveEncrypted, setArchiveEncrypted] = useState(false);
  const [downloadRequested, setDownloadRequested] = useState(false);
  const backup = useBackupDownload();
  const busy =
    backup.create.isPending ||
    backup.cancel.isPending ||
    (backup.jobId !== null && backup.job.isPending) ||
    backup.job.data?.status === "creating";
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  const error = backup.create.error ?? backup.job.error ?? backup.cancel.error;
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const form = makeForm({
    defaultValues: { encrypted: BACKUP_RESTORE_DEFAULTS.encrypt as boolean, password: "", confirmation: "" },
    validator: backupProblems,
    onSubmit: (draft) => {
      if (busy || Object.keys(backupProblems(draft)).length > 0) return;
      setArchiveEncrypted(draft.encrypted);
      setStep("progress");
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
  const failure = error?.message ?? backup.job.data?.error;
  const finished = backup.job.data?.status === "ready";
  const restart = async () => {
    if (backup.jobId) await backup.cancel.mutateAsync();
    backup.create.reset();
    backup.cancel.reset();
    form.reset();
    setDownloadRequested(false);
    setStep("configure");
  };
  if (step === "progress")
    return (
      <BackupWorkflow
        title="Backing Up Your Server"
        description="Keep this page open while your archive is created."
        footer={
          <>
            <span />
            {failure ? (
              <Button variant="ghost" disabled={busy} onClick={() => void restart().catch(() => {})}>
                Back
              </Button>
            ) : (
              <Button disabled={!finished || busy} onClick={() => setStep("complete")}>
                {finished ? "Next" : "Backing up…"}
              </Button>
            )}
          </>
        }
      >
        {failure ? (
          <BackupError message={failure} />
        ) : (
          <BackupProgress
            finished={finished}
            title={finished ? "Backup finished" : "Creating your backup"}
            description={
              finished
                ? "Select Next to review the saved archive."
                : "Your server can keep running while the archive is created."
            }
          >
            <ul className="flex list-disc flex-col gap-2 pl-5 text-muted-foreground">
              <li>The database and server files are captured in one archive.</li>
              {archiveEncrypted && <li>The archive is encrypted with your password.</li>}
              <li>When the backup finishes, select Next to review and download it.</li>
            </ul>
          </BackupProgress>
        )}
      </BackupWorkflow>
    );
  if (step === "complete")
    return (
      <BackupWorkflow
        title="Backup Complete"
        description="Your archive is ready to download."
        footer={
          <>
            <Button variant="ghost" disabled={backup.cancel.isPending} onClick={() => void restart().catch(() => {})}>
              Done
            </Button>
            {!downloadRequested && backup.downloadUrl && (
              <Button
                nativeButton={false}
                role="link"
                render={<a href={backup.downloadUrl} download />}
                onClick={() => setDownloadRequested(true)}
              >
                Download backup
              </Button>
            )}
          </>
        }
      >
        <BackupProgress
          finished
          title="Your backup is ready"
          description="Keep this archive somewhere safe so you can restore your server later."
        >
          <BackupFacts
            rows={[
              { label: "Archive", value: backup.job.data?.filename ?? "Unavailable" },
              {
                label: "Size",
                value:
                  backup.job.data?.bytes === undefined
                    ? "Unavailable"
                    : `${backup.job.data.bytes.toLocaleString()} bytes`,
              },
              { label: "Encryption", value: archiveEncrypted ? "On" : "Off" },
            ]}
          />
          <p className="text-muted-foreground">
            {downloadRequested
              ? "Download requested. Check your browser’s downloads for the archive."
              : "This download is available once, for one hour."}
          </p>
        </BackupProgress>
        {failure && <BackupError message={failure} />}
      </BackupWorkflow>
    );
  return (
    <BackupWorkflow
      title="Back Up Your Server"
      description="Save the database, supported configuration, identity, plugins and captured logs."
      footer={
        <>
          <span />
          <Button type="submit" form="create-backup-form" disabled={disabled}>
            Create backup
          </Button>
        </>
      }
    >
      <form
        id="create-backup-form"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        className="flex flex-col gap-4"
      >
        <FieldGroup className="gap-4">
          <Field className="flex-row items-center gap-2">
            <Switch
              id="backup-encrypt"
              checked={encrypted}
              onCheckedChange={(value) => form.setFieldValue("encrypted", value)}
              disabled={busy}
            />
            <FieldLabel className="font-strong text-label" htmlFor="backup-encrypt">
              Encrypt the archive with a password
            </FieldLabel>
          </Field>
          {encrypted && (
            <>
              <form.Field name="password">
                {(field) => {
                  const problem =
                    !busy && field.state.meta.isTouched && focusedField !== "password"
                      ? fieldError(field.state.meta.errors)
                      : null;
                  return (
                    <Field data-invalid={!!problem}>
                      <FieldLabel className="font-strong text-label" htmlFor="backup-password">
                        Archive password
                      </FieldLabel>
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
                        <p role="alert" className="text-detail text-warning">
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
                    !busy && field.state.meta.isTouched && focusedField !== "confirmation"
                      ? fieldError(field.state.meta.errors)
                      : null;
                  return (
                    <Field data-invalid={!!problem}>
                      <FieldLabel className="font-strong text-label" htmlFor="backup-confirm">
                        Confirm archive password
                      </FieldLabel>
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
                        <p role="alert" className="text-detail text-warning">
                          {problem}
                        </p>
                      )}
                    </Field>
                  );
                }}
              </form.Field>
              <p className="text-detail text-muted-foreground">{BACKUP_PASSWORD_GUIDANCE}</p>
            </>
          )}
        </FieldGroup>
        {error && <BackupError message={error.message} />}
        {backup.job.data?.error && <BackupError message={backup.job.data.error} />}
      </form>
    </BackupWorkflow>
  );
}
