import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Switch } from "@internal/node-admin";
import { BACKUP_RESTORE_DEFAULTS, BACKUP_RESTORE_MODES, type RestoreMode } from "@internal/subshell-protocol";
import { useStore } from "@tanstack/react-form";
import { useState } from "react";
import { CopyCommandRow } from "@/components/copy-command-row";
import { ErrorBanner } from "@/components/error-banner";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRestoreBackup } from "@/hooks/use-backups";
import { desktopInvokeStrict, desktopShell } from "@/lib/desktop";
import { type FieldProblems, fieldError, makeForm, useSubmitDisabled } from "@/lib/form";

type InspectionDraft = { file: File | null; password: string };
function inspectionProblems(draft: InspectionDraft): FieldProblems {
  const problems: FieldProblems = {};
  if (!draft.file) problems.file = "Choose a backup archive or legacy .db snapshot.";
  if (draft.password.length > 4096) problems.password = "Archive password must be at most 4096 characters.";
  return problems;
}

type PreparationDraft = { recover: boolean; adminId: string; temporaryPassword: string; confirmation: string };
function preparationProblems(draft: PreparationDraft, adminIds: string[]): FieldProblems {
  if (!draft.recover) return {};
  const problems: FieldProblems = {};
  if (!adminIds.includes(draft.adminId)) problems.adminId = "Select an existing administrator.";
  if (draft.temporaryPassword.length < 8 || draft.temporaryPassword.length > 4096)
    problems.temporaryPassword = "Temporary password must be 8–4096 characters.";
  if (!draft.confirmation || draft.temporaryPassword !== draft.confirmation)
    problems.confirmation = "Temporary passwords do not match.";
  return problems;
}

export function RestoreBackupCard() {
  const restore = useRestoreBackup();
  const [mode, setMode] = useState<RestoreMode>(BACKUP_RESTORE_DEFAULTS.mode);
  const [baseUrl, setBaseUrl] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [trustedOrigins, setTrustedOrigins] = useState("");
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const inspected = restore.inspect.data;
  const prepared = restore.prepare.data;
  const busy = restore.inspect.isPending || restore.prepare.isPending || restore.cancel.isPending;
  const error = restore.inspect.error ?? restore.prepare.error ?? restore.cancel.error;
  const admins = inspected?.admins.map((admin) => ({ value: admin.id, label: `${admin.name} (${admin.email})` })) ?? [];

  const [focusedField, setFocusedField] = useState<string | null>(null);
  const prepareForm = makeForm({
    defaultValues: {
      recover: BACKUP_RESTORE_DEFAULTS.recoverAdmin as boolean,
      adminId: "",
      temporaryPassword: "",
      confirmation: "",
    },
    validator: (draft) =>
      preparationProblems(
        draft,
        admins.map((admin) => admin.value),
      ),
    onSubmit: (draft) => {
      if (
        busy ||
        !inspected ||
        Object.keys(
          preparationProblems(
            draft,
            admins.map((admin) => admin.value),
          ),
        ).length > 0
      )
        return;
      restore.prepare.mutate(
        {
          id: inspected.id,
          mode,
          configOverrides:
            mode === "migration"
              ? { baseUrl: baseUrl || undefined, host: host || undefined, port: port || undefined, trustedOrigins }
              : undefined,
          ...(draft.recover ? { recoveryUserId: draft.adminId, temporaryPassword: draft.temporaryPassword } : {}),
        },
        {
          onSuccess: () => {
            prepareForm.setFieldValue("temporaryPassword", "");
            prepareForm.setFieldValue("confirmation", "");
          },
        },
      );
    },
  });
  const inspectForm = makeForm({
    defaultValues: { file: null as File | null, password: "" },
    validator: inspectionProblems,
    onSubmit: (draft) => {
      if (busy || !draft.file || Object.keys(inspectionProblems(draft)).length > 0) return;
      restore.inspect.mutate(
        { file: draft.file, password: draft.password || undefined },
        {
          onSuccess: () => {
            inspectForm.setFieldValue("password", "");
            setMode(BACKUP_RESTORE_DEFAULTS.mode);
            prepareForm.reset();
            setBaseUrl("");
            setHost("");
            setPort("");
            setTrustedOrigins("");
          },
        },
      );
    },
  });
  const { recover } = useStore(prepareForm.store, (state) => state.values);
  const inspectDisabled = useSubmitDisabled(inspectForm, busy);
  const prepareDisabled = useSubmitDisabled(prepareForm, busy);

  async function cancel() {
    if (!inspected) return;
    await restore.cancel.mutateAsync(inspected.id);
    restore.inspect.reset();
    restore.prepare.reset();
    prepareForm.setFieldValue("temporaryPassword", "");
    prepareForm.setFieldValue("confirmation", "");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Restore backup</CardTitle>
        <CardDescription>
          Inspect an archive and prepare the restore. Apply it with the CLI or desktop assistant while the server is
          stopped.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!inspected && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void inspectForm.handleSubmit();
            }}
          >
            <FieldGroup>
              <inspectForm.Field name="file">
                {(field) => {
                  const problem =
                    field.state.meta.isTouched && focusedField !== "file" ? fieldError(field.state.meta.errors) : null;
                  return (
                    <Field data-invalid={!!problem}>
                      <FieldLabel htmlFor="restore-archive">Backup archive or legacy .db snapshot</FieldLabel>
                      <Input
                        id="restore-archive"
                        onFocus={() => setFocusedField("file")}
                        onBlur={() => {
                          field.handleBlur();
                          setFocusedField(null);
                        }}
                        aria-invalid={!!problem}
                        type="file"
                        required
                        disabled={busy}
                        onChange={(event) => field.handleChange(event.target.files?.[0] ?? null)}
                      />
                      {problem && (
                        <p role="alert" className="text-destructive text-detail">
                          {problem}
                        </p>
                      )}
                    </Field>
                  );
                }}
              </inspectForm.Field>
              <inspectForm.Field name="password">
                {(field) => {
                  const problem =
                    field.state.meta.isTouched && focusedField !== "password"
                      ? fieldError(field.state.meta.errors)
                      : null;
                  return (
                    <Field data-invalid={!!problem}>
                      <FieldLabel htmlFor="restore-password">Archive password, if encrypted</FieldLabel>
                      <Input
                        id="restore-password"
                        onFocus={() => setFocusedField("password")}
                        onBlur={() => {
                          field.handleBlur();
                          setFocusedField(null);
                        }}
                        aria-invalid={!!problem}
                        type="password"
                        maxLength={4096}
                        autoComplete="off"
                        disabled={busy}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      {problem && (
                        <p role="alert" className="text-destructive text-detail">
                          {problem}
                        </p>
                      )}
                    </Field>
                  );
                }}
              </inspectForm.Field>
            </FieldGroup>
            <p className="text-detail text-muted-foreground">
              Browser uploads support archives under 128 MB. Use the CLI or desktop assistant for larger files.
            </p>
            <Button type="submit" disabled={inspectDisabled}>
              {restore.inspect.isPending ? "Inspecting…" : "Inspect backup"}
            </Button>
          </form>
        )}
        {inspected && (
          <>
            <div className="space-y-2 text-body">
              <p>
                {inspected.legacyDatabaseOnly
                  ? "Legacy database-only snapshot: settings, identities, plugins, and files will stay as they are."
                  : `Full instance backup from ${new Date(inspected.manifest.completedAt).toLocaleString()}.`}
              </p>
              <p className="text-detail text-muted-foreground">
                Server version {inspected.manifest.serverVersion} · {inspected.manifest.entries.length} files. Staging
                expires at {new Date(inspected.expiresAt).toLocaleTimeString()}.
              </p>
            </div>
            {!prepared && (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void prepareForm.handleSubmit();
                }}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="restore-mode">Restore destination</FieldLabel>
                    <Select
                      items={BACKUP_RESTORE_MODES}
                      disabled={inspected.legacyDatabaseOnly}
                      value={mode}
                      onValueChange={(value) => {
                        if (value) setMode(value);
                      }}
                    >
                      <SelectTrigger id="restore-mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {BACKUP_RESTORE_MODES.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  {mode === "migration" && (
                    <>
                      <p className="text-detail text-muted-foreground">
                        The offline tool will confirm destination paths. Network publication stays disabled until you
                        review Networking. Leave the server address and listen fields blank to keep the archive's
                        values. Blank extra origins clears the previous list.
                      </p>
                      <Field>
                        <FieldLabel htmlFor="restore-base-url">Server address</FieldLabel>
                        <Input
                          id="restore-base-url"
                          value={baseUrl}
                          onChange={(event) => setBaseUrl(event.target.value)}
                          placeholder="https://subshell.example.com"
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="restore-host">Listen host</FieldLabel>
                        <Input
                          id="restore-host"
                          value={host}
                          onChange={(event) => setHost(event.target.value)}
                          placeholder="127.0.0.1"
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="restore-port">Listen port</FieldLabel>
                        <Input
                          id="restore-port"
                          value={port}
                          onChange={(event) => setPort(event.target.value)}
                          inputMode="numeric"
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="restore-origins">Extra trusted origins</FieldLabel>
                        <Input
                          id="restore-origins"
                          value={trustedOrigins}
                          onChange={(event) => setTrustedOrigins(event.target.value)}
                          placeholder="https://subshell.example.com"
                        />
                      </Field>
                    </>
                  )}
                  <Field className="flex-row items-center justify-between">
                    <FieldLabel htmlFor="restore-recover">Set a temporary password for an existing admin</FieldLabel>
                    <Switch
                      id="restore-recover"
                      checked={recover}
                      onCheckedChange={(value) => prepareForm.setFieldValue("recover", value)}
                      disabled={admins.length === 0}
                    />
                  </Field>
                  {recover && (
                    <>
                      <prepareForm.Field name="adminId">
                        {(field) => {
                          const problem =
                            field.state.meta.isTouched && focusedField !== "adminId"
                              ? fieldError(field.state.meta.errors)
                              : null;
                          return (
                            <Field data-invalid={!!problem}>
                              <FieldLabel htmlFor="restore-admin">Administrator</FieldLabel>
                              <Select
                                items={admins}
                                value={field.state.value || null}
                                onValueChange={(value) => field.handleChange(value ?? "")}
                              >
                                <SelectTrigger
                                  id="restore-admin"
                                  onFocus={() => setFocusedField("adminId")}
                                  onBlur={() => {
                                    field.handleBlur();
                                    setFocusedField(null);
                                  }}
                                  aria-invalid={!!problem}
                                >
                                  <SelectValue placeholder="Select an admin" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {admins.map((admin) => (
                                      <SelectItem key={admin.value} value={admin.value}>
                                        {admin.label}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                              {problem && (
                                <p role="alert" className="text-destructive text-detail">
                                  {problem}
                                </p>
                              )}
                            </Field>
                          );
                        }}
                      </prepareForm.Field>
                      <prepareForm.Field name="temporaryPassword">
                        {(field) => {
                          const problem =
                            field.state.meta.isTouched && focusedField !== "temporaryPassword"
                              ? fieldError(field.state.meta.errors)
                              : null;
                          return (
                            <Field data-invalid={!!problem}>
                              <FieldLabel htmlFor="restore-temp-password">Temporary password</FieldLabel>
                              <Input
                                id="restore-temp-password"
                                onFocus={() => setFocusedField("temporaryPassword")}
                                onBlur={() => {
                                  field.handleBlur();
                                  setFocusedField(null);
                                }}
                                aria-invalid={!!problem}
                                type="password"
                                maxLength={4096}
                                autoComplete="new-password"
                                minLength={8}
                                required
                                value={field.state.value}
                                onChange={(event) => field.handleChange(event.target.value)}
                              />
                              {problem && (
                                <p role="alert" className="text-destructive text-detail">
                                  {problem}
                                </p>
                              )}
                            </Field>
                          );
                        }}
                      </prepareForm.Field>
                      <prepareForm.Field name="confirmation">
                        {(field) => {
                          const problem =
                            field.state.meta.isTouched && focusedField !== "confirmation"
                              ? fieldError(field.state.meta.errors)
                              : null;
                          return (
                            <Field data-invalid={!!problem}>
                              <FieldLabel htmlFor="restore-temp-confirm">Confirm temporary password</FieldLabel>
                              <Input
                                id="restore-temp-confirm"
                                onFocus={() => setFocusedField("confirmation")}
                                onBlur={() => {
                                  field.handleBlur();
                                  setFocusedField(null);
                                }}
                                aria-invalid={!!problem}
                                type="password"
                                maxLength={4096}
                                autoComplete="new-password"
                                required
                                value={field.state.value}
                                onChange={(event) => field.handleChange(event.target.value)}
                              />
                              {problem && (
                                <p role="alert" className="text-destructive text-detail">
                                  {problem}
                                </p>
                              )}
                            </Field>
                          );
                        }}
                      </prepareForm.Field>
                      <p className="text-detail text-muted-foreground">
                        Password sign-in will be enabled. This admin must change the temporary password before accessing
                        the restored server.
                      </p>
                    </>
                  )}
                </FieldGroup>
                <p className="text-detail text-muted-foreground">
                  Restore replaces the destination state and signs everyone out. Running panes need explicit
                  confirmation in the offline tool.
                </p>
                <Button type="submit" disabled={prepareDisabled}>
                  {restore.prepare.isPending ? "Preparing…" : "Prepare restore"}
                </Button>
              </form>
            )}
            {prepared && (
              <div className="space-y-3">
                <p className="text-body">Restore is prepared. Run this command on the server host:</p>
                <CopyCommandRow text={prepared.command} label="restore command" />
                <p className="text-detail text-muted-foreground">
                  The tool confirms the replacement, stops the server, and asks whether to start it afterward (Yes by
                  default). This browser will lose its connection during restore.
                </p>
                {desktopShell()?.app === "server" && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      void desktopInvokeStrict("desktop_open_assistant", { screen: "restore" }).catch(
                        (failure: unknown) =>
                          setDesktopError(failure instanceof Error ? failure.message : "Could not open assistant."),
                      );
                    }}
                  >
                    Open restore assistant
                  </Button>
                )}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void cancel().catch(() => {});
              }}
            >
              Discard staged restore
            </Button>
          </>
        )}
        {error && <ErrorBanner message={error.message} className="rounded-md border" />}
        {desktopError && <ErrorBanner message={desktopError} className="rounded-md border" />}
      </CardContent>
    </Card>
  );
}
