import { Button, Input, Switch } from "@internal/node-admin";
import { BACKUP_RESTORE_DEFAULTS, BACKUP_RESTORE_MODES, type RestoreMode } from "@internal/subshell-protocol";
import { useStore } from "@tanstack/react-form";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyCommandRow } from "@/components/copy-command-row";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type RestoreInspection, useRestoreBackup } from "@/hooks/use-backups";
import { desktopInvokeStrict, desktopShell } from "@/lib/desktop";
import { type FieldProblems, fieldError, makeForm, useSubmitDisabled } from "@/lib/form";
import { Card, CardContent, CardHeader, CardTitle } from "./backup-card";
import { BackupError, BackupFacts, BackupProgress, BackupWorkflow } from "./backup-workflow";

type InspectionDraft = { file: File | null; path: string; password: string; encrypted: boolean };
function inspectionProblems(draft: InspectionDraft): FieldProblems {
  const problems: FieldProblems = {};
  if (!draft.file && !draft.path) problems.file = "Choose a backup file.";
  if (draft.file && draft.file.size > 128 * 1024 * 1024)
    problems.file = "Use the CLI or desktop assistant for files larger than 128 MB.";
  if (draft.encrypted && !draft.password) problems.password = "Enter the archive password.";
  if (draft.password.length > 4096 || /[\r\n\0]/.test(draft.password))
    problems.password = "Use a password of at most 4096 characters on one line.";
  return problems;
}

type ConfigurationDraft = {
  mode: RestoreMode;
  recover: boolean;
  adminId: string;
  temporaryPassword: string;
  confirmation: string;
  databasePath: string;
  dataDir: string;
  configDir: string;
  baseUrl: string;
  host: string;
  port: string;
  trustedOrigins: string;
  start: boolean;
};
type TextField =
  | "temporaryPassword"
  | "confirmation"
  | "databasePath"
  | "dataDir"
  | "configDir"
  | "baseUrl"
  | "host"
  | "port"
  | "trustedOrigins";
const CONFIGURATION_DEFAULTS: ConfigurationDraft = {
  mode: BACKUP_RESTORE_DEFAULTS.mode,
  recover: false,
  adminId: "",
  temporaryPassword: "",
  confirmation: "",
  databasePath: "",
  dataDir: "",
  configDir: "",
  baseUrl: "",
  host: "",
  port: "",
  trustedOrigins: "",
  start: true,
};
function originProblem(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !/^https?:$/.test(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      /[\s*?\\]/.test(value)
    )
      return "Use an HTTP or HTTPS origin without a path or credentials.";
    return null;
  } catch {
    return "Use an HTTP or HTTPS origin without a path or credentials.";
  }
}
function configurationProblems(draft: ConfigurationDraft, inspection: RestoreInspection | null): FieldProblems {
  const problems: FieldProblems = {};
  if (!inspection?.legacyDatabaseOnly) {
    for (const name of ["databasePath", "dataDir", "configDir"] as const) {
      if (draft[name] && (!draft[name].startsWith("/") || /[\r\n\0]/.test(draft[name])))
        problems[name] = "Use an absolute path.";
    }
    if (draft.port && (!/^\d+$/.test(draft.port) || Number(draft.port) < 1 || Number(draft.port) > 65535))
      problems.port = "Enter a port from 1 to 65535.";
    if (draft.host && !/^[a-zA-Z0-9.:[\]_-]+$/.test(draft.host)) problems.host = "Use a hostname or IP address.";
    if (draft.baseUrl) {
      const problem = originProblem(draft.baseUrl);
      if (problem) problems.baseUrl = problem;
    }
    if (draft.trustedOrigins.split(",").some((value) => value.trim() && originProblem(value.trim())))
      problems.trustedOrigins = "Use HTTP or HTTPS origins separated by commas.";
  }
  if (draft.recover) {
    if (!inspection?.admins.some((admin) => admin.id === draft.adminId))
      problems.adminId = "Select an existing administrator.";
    if (
      draft.temporaryPassword.length < 8 ||
      draft.temporaryPassword.length > 4096 ||
      /[\r\n\0]/.test(draft.temporaryPassword)
    )
      problems.temporaryPassword = "Use a temporary password of 8–4096 characters on one line.";
    if (!draft.confirmation || draft.temporaryPassword !== draft.confirmation)
      problems.confirmation = "Temporary passwords do not match.";
  }
  return problems;
}

type Step = "select" | "configure" | "review" | "progress";
export function RestoreBackupCard({ onBusy }: { onBusy?: (busy: boolean) => void }) {
  const restore = useRestoreBackup();
  const [step, setStep] = useState<Step>("select");
  const [source, setSource] = useState<"file" | "saved">("file");
  const [inspection, setInspection] = useState<RestoreInspection | null>(null);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [selectionProblem, setSelectionProblem] = useState<string | null>(null);
  const [passwordProblem, setPasswordProblem] = useState<string | null>(null);
  const [preparationProblem, setPreparationProblem] = useState<string | null>(null);
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const sourceRequest = useRef<{ file?: File; path?: string; password?: string } | null>(null);
  const validationSequence = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const busy = restore.inspect.isPending || restore.prepare.isPending || restore.cancel.isPending;
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  const configuration = makeForm({
    defaultValues: CONFIGURATION_DEFAULTS,
    validator: (draft) => configurationProblems(draft, inspection),
    onSubmit: (draft) => {
      if (busy || !inspection || Object.keys(configurationProblems(draft, inspection)).length) return;
      review.setFieldValue("confirmed", false);
      setPreparationProblem(null);
      setStep("review");
    },
  });
  const draft = useStore(configuration.store, (state) => state.values);
  const inspectForm = makeForm({
    defaultValues: { file: null as File | null, path: "", password: "", encrypted: false },
    validator: inspectionProblems,
    onSubmit: async (values) => {
      if (busy || Object.keys(inspectionProblems(values)).length) return;
      await validateSelection(values);
    },
  });
  const selected = useStore(inspectForm.store, (state) => state.values);
  const review = makeForm({
    defaultValues: { confirmed: false },
    validator: (values): FieldProblems =>
      values.confirmed ? {} : { confirmed: "Confirm the displayed restore details." },
    onSubmit: async (values) => {
      if (
        busy ||
        !values.confirmed ||
        !inspection ||
        Object.keys(configurationProblems(configuration.state.values, inspection)).length
      )
        return;
      await prepareRestore();
    },
  });
  const inspectDisabled = useSubmitDisabled(inspectForm, busy);
  const configureDisabled = useSubmitDisabled(inspectForm, busy || !inspection);
  const reviewDisabled = useSubmitDisabled(configuration, busy);
  const prepareDisabled = useSubmitDisabled(
    review,
    busy || Object.keys(configurationProblems(draft, inspection)).length > 0,
  );
  const admins =
    inspection?.admins.map((admin) => ({ value: admin.id, label: `${admin.name} · ${admin.email}` })) ?? [];

  async function removeStage(id: string) {
    try {
      await restore.cancel.mutateAsync(id);
    } catch (error) {
      if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
    }
  }
  async function validateSelection(values: InspectionDraft) {
    const sequence = ++validationSequence.current;
    const old = inspection;
    setInspection(null);
    setSelectionProblem(null);
    setPasswordProblem(null);
    restore.prepare.reset();
    const problems = inspectionProblems({ ...values, encrypted: false });
    if (Object.keys(problems).length) {
      setSelectionProblem(problems.file ?? problems.password ?? null);
      return;
    }
    const request = {
      ...(values.path ? { path: values.path } : { file: values.file ?? undefined }),
      ...(values.password && { password: values.password }),
    };
    try {
      const result = await restore.inspect.mutateAsync(request);
      if (sequence !== validationSequence.current) {
        await removeStage(result.id);
        return;
      }
      if (old) await removeStage(old.id);
      sourceRequest.current = request;
      setInspection(result);
      const addresses = result.choices?.configOverrides;
      configuration.reset(
        {
          ...CONFIGURATION_DEFAULTS,
          databasePath: result.destination?.databasePath ?? "",
          dataDir: result.destination?.dataDir ?? "",
          configDir: result.destination?.configPath.replace(/[/\\][^/\\]+$/, "") ?? "",
          baseUrl: addresses?.baseUrl ?? "",
          host: addresses?.host ?? "",
          port: String(addresses?.port ?? ""),
          trustedOrigins: addresses?.trustedOrigins ?? "",
        },
        { keepDefaultValues: true },
      );
    } catch (error) {
      if (sequence !== validationSequence.current) return;
      const message = error instanceof Error ? error.message : "Could not validate this backup.";
      if (/requires a password|password.*password-file/i.test(message)) {
        inspectForm.setFieldValue("encrypted", true);
        setPasswordProblem("This backup is encrypted. Enter its archive password, then select Validate backup.");
      } else if (/authentication failed|wrong password/i.test(message)) {
        inspectForm.setFieldValue("encrypted", true);
        setPasswordProblem("The password is incorrect or this backup is damaged. Check the password and try again.");
      } else setSelectionProblem(message.replace(/^subshell-server: restore failed:\s*/, ""));
    }
  }
  async function resetSelection(discard = true) {
    validationSequence.current++;
    if (discard && inspection) await removeStage(inspection.id);
    setInspection(null);
    sourceRequest.current = null;
    inspectForm.reset();
    configuration.reset();
    restore.inspect.reset();
    restore.prepare.reset();
    restore.cancel.reset();
    setSelectionProblem(null);
    setPasswordProblem(null);
    setPreparationProblem(null);
    setStep("select");
  }
  function destination(values: ConfigurationDraft) {
    return {
      databasePath: values.databasePath || inspection?.destination?.databasePath || "",
      dataDir: values.dataDir || inspection?.destination?.dataDir || "",
      configPath: values.configDir
        ? `${values.configDir.replace(/\/$/, "")}/config.env`
        : inspection?.destination?.configPath || "",
    };
  }
  async function prepareRestore() {
    if (!inspection) return;
    setPreparationProblem(null);
    setStep("progress");
    try {
      let current = inspection;
      const refresh = async () => {
        if (!sourceRequest.current) throw new Error("Select the backup again to validate it.");
        const refreshed = await restore.inspect.mutateAsync(sourceRequest.current);
        setInspection(refreshed);
        if (
          JSON.stringify(refreshed.manifest) !== JSON.stringify(current.manifest) ||
          JSON.stringify(refreshed.admins) !== JSON.stringify(current.admins) ||
          JSON.stringify(refreshed.destination) !== JSON.stringify(current.destination)
        ) {
          review.setFieldValue("confirmed", false);
          setStep("review");
          throw new Error("The backup changed. Review it again before preparing the restore.");
        }
        current = refreshed;
      };
      if (current.expiresAt <= Date.now()) await refresh();
      const values = configuration.state.values;
      const request = () => ({
        id: current.id,
        mode: current.legacyDatabaseOnly ? ("same-machine" as const) : values.mode,
        start: values.start,
        ...(!current.legacyDatabaseOnly && {
          destination: destination(values),
          configOverrides: {
            baseUrl: values.baseUrl || undefined,
            host: values.host || undefined,
            port: values.port || undefined,
            trustedOrigins: values.trustedOrigins,
          },
        }),
        ...(values.recover && { recoveryUserId: values.adminId, temporaryPassword: values.temporaryPassword }),
      });
      try {
        await restore.prepare.mutateAsync(request());
      } catch (error) {
        if (!(error instanceof Error && /expired|already prepared/i.test(error.message))) throw error;
        await refresh();
        await restore.prepare.mutateAsync(request());
      }
      // The configuration fields are already unmounted on this progress pane.
      configuration.setFieldValue("temporaryPassword", "");
      configuration.setFieldValue("confirmation", "");
      inspectForm.setFieldValue("password", "");
    } catch (error) {
      setPreparationProblem(error instanceof Error ? error.message : "Could not prepare the restore.");
    }
  }
  function textField(name: TextField, label: string, password = false) {
    return (
      <configuration.Field name={name}>
        {(field) => {
          const problem =
            !busy && field.state.meta.isTouched && focusedField !== name ? fieldError(field.state.meta.errors) : null;
          return (
            <Field data-invalid={!!problem}>
              <FieldLabel className="font-strong text-label" htmlFor={`restore-${name}`}>
                {label}
              </FieldLabel>
              <Input
                id={`restore-${name}`}
                value={field.state.value}
                type={password ? "password" : "text"}
                required={password}
                autoComplete={password ? "new-password" : "off"}
                maxLength={4096}
                disabled={busy}
                aria-invalid={!!problem}
                aria-describedby={problem ? `restore-${name}-error` : undefined}
                onFocus={() => setFocusedField(name)}
                onBlur={() => {
                  field.handleBlur();
                  setFocusedField(null);
                }}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              {problem && (
                <p id={`restore-${name}-error`} role="alert" className="text-detail text-warning">
                  {problem}
                </p>
              )}
            </Field>
          );
        }}
      </configuration.Field>
    );
  }
  function failureBanner() {
    return preparationProblem ? <BackupError message={preparationProblem} /> : null;
  }
  const archiveName =
    selected.file?.name ??
    restore.saved.data?.backups.find((file) => file.path === selected.path)?.name ??
    "Selected backup";
  const details = inspection
    ? [
        { label: "Archive", value: archiveName },
        {
          label: "Backup type",
          value: inspection.legacyDatabaseOnly ? "Database-only snapshot" : "Full instance archive",
        },
        { label: "Captured", value: new Date(inspection.manifest.completedAt).toLocaleString() },
        {
          label: "Server version",
          value:
            inspection.manifest.serverVersion === "legacy"
              ? "Unknown (not recorded in this backup)"
              : inspection.manifest.serverVersion,
        },
        {
          label: "Restore mode",
          value: draft.mode === "migration" ? "This machine is different from the original" : "Same-machine recovery",
        },
        ...Object.entries(destination(draft)).map(([key, value]) => ({
          label: key === "databasePath" ? "Database" : key === "dataDir" ? "Data directory" : "Configuration",
          value,
          copy: true,
        })),
        {
          label: "Control plane URL",
          value: draft.baseUrl || inspection.choices?.configOverrides?.baseUrl || "Current configuration",
          copy: true,
        },
        {
          label: "Bind address",
          value: draft.host || inspection.choices?.configOverrides?.host || "Current configuration",
        },
        {
          label: "Port",
          value: draft.port || String(inspection.choices?.configOverrides?.port ?? "Current configuration"),
        },
        {
          label: "Admin recovery",
          value: draft.recover
            ? (inspection.admins.find((admin) => admin.id === draft.adminId)?.email ?? "Enabled")
            : "Off",
        },
        { label: "Start after restoring", value: draft.start ? "Yes" : "No" },
      ]
    : [];

  if (step === "progress" && (!restore.prepare.data || preparationProblem))
    return (
      <BackupWorkflow
        title="Prepare Restore"
        description="Your server stays running while the restore is prepared."
        footer={
          <>
            <span />
            {preparationProblem ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  review.setFieldValue("confirmed", false);
                  setStep("review");
                }}
              >
                Back
              </Button>
            ) : (
              <Button disabled>Preparing…</Button>
            )}
          </>
        }
      >
        {failureBanner() ?? (
          <BackupProgress
            finished={false}
            title="Preparing your restore"
            description="The backup and your configuration are checked before anything is replaced."
          >
            <ul className="flex list-disc flex-col gap-2 pl-5 text-muted-foreground">
              <li>Your restore choices are saved in a private prepared copy.</li>
              {draft.recover && <li>The selected administrator receives the temporary password on restore.</li>}
              <li>The host command appears here when preparation finishes.</li>
            </ul>
          </BackupProgress>
        )}
      </BackupWorkflow>
    );
  if (step === "progress" && restore.prepare.data)
    return (
      <BackupWorkflow
        title="Prepare Restore"
        description="Apply this restore on the server host."
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void resetSelection(false).catch((error) => setPreparationProblem(String(error)))}
            >
              Done
            </Button>
            {desktopShell()?.app === "server" && (
              <Button
                onClick={() =>
                  void desktopInvokeStrict("desktop_open_assistant", { screen: "restore" }).catch((error: unknown) =>
                    setDesktopError(error instanceof Error ? error.message : "Could not open assistant."),
                  )
                }
              >
                Open restore assistant
              </Button>
            )}
          </>
        }
      >
        <BackupProgress
          finished
          title="Your restore is ready to apply"
          description="The backup is prepared. Your server’s state has not been replaced."
        >
          {restore.prepare.data && (
            <>
              <p>Run this command on the server host:</p>
              <CopyCommandRow text={restore.prepare.data.command} label="restore command" />
            </>
          )}
          <BackupFacts rows={details} />
          <p className="text-muted-foreground">
            The host tool confirms replacement and checks active sessions before applying. The browser disconnects
            during restore; sign in again afterward.
          </p>
          <p className="text-muted-foreground">
            This prepared copy is available for ten minutes. Keep the source backup to prepare it again if needed.
          </p>
        </BackupProgress>
        {desktopError && <BackupError message={desktopError} />}
        {failureBanner()}
      </BackupWorkflow>
    );
  if (step === "review")
    return (
      <BackupWorkflow
        title="Review Restore"
        description="Review these details before preparing the replacement."
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setStep("configure")}>
              Back
            </Button>
            <Button type="submit" form="review-restore-form" disabled={prepareDisabled}>
              Prepare restore
            </Button>
          </>
        }
      >
        <Card>
          <CardHeader>
            <CardTitle>Backup to restore</CardTitle>
          </CardHeader>
          <CardContent>
            <BackupFacts rows={details} />
          </CardContent>
        </Card>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-muted-foreground">
          <li>Applying this restore replaces the displayed destination and signs everyone out.</li>
          <li>
            Compatible sessions are preserved. If any cannot survive the restore, the host tool asks for interruption
            consent.
          </li>
          {draft.mode === "migration" && <li>Network publication stays disabled until you review Networking.</li>}
        </ul>
        <form
          id="review-restore-form"
          onSubmit={(event) => {
            event.preventDefault();
            void review.handleSubmit();
          }}
        >
          <FieldGroup className="gap-4">
            <review.Field name="confirmed">
              {(field) => (
                <Field className="flex-row items-center" data-disabled={busy}>
                  <Checkbox
                    id="restore-confirm"
                    checked={field.state.value}
                    disabled={busy}
                    onCheckedChange={field.handleChange}
                  />
                  <FieldLabel className="font-strong text-label" htmlFor="restore-confirm">
                    I confirm the destination and restore options shown above
                  </FieldLabel>
                </Field>
              )}
            </review.Field>
          </FieldGroup>
        </form>
        {failureBanner()}
      </BackupWorkflow>
    );
  if (step === "configure")
    return (
      <BackupWorkflow
        title="Configure Restore"
        description="Configure the destination and restore options, then review the replacement."
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setStep("select")}>
              Back
            </Button>
            <Button type="submit" form="configure-restore-form" disabled={reviewDisabled}>
              Review backup
            </Button>
          </>
        }
      >
        <form
          id="configure-restore-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void configuration.handleSubmit();
          }}
        >
          <Card>
            <CardHeader>
              <CardTitle>Restore settings</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel className="font-strong text-label" htmlFor="restore-mode">
                    Restore mode
                  </FieldLabel>
                  <RadioGroup
                    aria-label="Restore mode"
                    aria-describedby="restore-mode-description"
                    disabled={busy || inspection?.legacyDatabaseOnly}
                    value={draft.mode}
                    onValueChange={(value) =>
                      configuration.setFieldValue("mode", value === "migration" ? "migration" : "same-machine")
                    }
                  >
                    {BACKUP_RESTORE_MODES.map((item) => (
                      <Field key={item.value} className="flex-row items-center gap-2">
                        <RadioGroupItem id={`restore-mode-${item.value}`} value={item.value} />
                        <FieldLabel htmlFor={`restore-mode-${item.value}`} className="font-strong text-label">
                          {item.label}
                        </FieldLabel>
                      </Field>
                    ))}
                  </RadioGroup>
                  <p id="restore-mode-description" className="m-0 text-detail text-muted-foreground">
                    {BACKUP_RESTORE_MODES.find((mode) => mode.value === draft.mode)?.description}
                  </p>
                  {inspection?.legacyDatabaseOnly && (
                    <p className="text-muted-foreground">
                      This backup contains only the database. It restores into this server using its current
                      configuration and identity. Moving to a new machine requires a full instance archive.
                    </p>
                  )}
                </Field>
                {!inspection?.legacyDatabaseOnly && (
                  <>
                    {textField("databasePath", "Database path (optional)")}
                    {textField("dataDir", "Data directory (optional)")}
                    {textField("configDir", "Configuration directory (optional)")}
                    {textField("baseUrl", "Control plane URL (optional)")}
                    {textField("host", "Bind address (optional)")}
                    {textField("port", "Port (optional)")}
                    {textField("trustedOrigins", "Trusted origins (optional)")}
                  </>
                )}
                <Field className="flex-row items-center gap-2">
                  <Switch
                    id="restore-recover"
                    checked={draft.recover}
                    onCheckedChange={(value) => configuration.setFieldValue("recover", value)}
                    disabled={busy || !admins.length}
                  />
                  <FieldLabel className="font-strong text-label" htmlFor="restore-recover">
                    Recover an existing administrator
                  </FieldLabel>
                </Field>
                {draft.recover && (
                  <>
                    <p className="text-warning">
                      Email/password authentication will be enabled. This administrator must change the temporary
                      password after signing in.
                    </p>
                    <configuration.Field name="adminId">
                      {(field) => {
                        const problem =
                          !busy && field.state.meta.isTouched && focusedField !== "adminId"
                            ? fieldError(field.state.meta.errors)
                            : null;
                        return (
                          <Field data-invalid={!!problem}>
                            <FieldLabel className="font-strong text-label" htmlFor="restore-admin">
                              Administrator
                            </FieldLabel>
                            <Select
                              items={admins}
                              disabled={busy}
                              value={field.state.value || null}
                              onValueChange={(value) => field.handleChange(value ?? "")}
                            >
                              <SelectTrigger
                                id="restore-admin"
                                aria-invalid={!!problem}
                                onFocus={() => setFocusedField("adminId")}
                                onBlur={() => {
                                  field.handleBlur();
                                  setFocusedField(null);
                                }}
                              >
                                <SelectValue placeholder="Select an administrator" />
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
                              <p role="alert" className="text-detail text-warning">
                                {problem}
                              </p>
                            )}
                          </Field>
                        );
                      }}
                    </configuration.Field>
                    {textField("temporaryPassword", "Temporary password (at least eight characters)", true)}
                    {textField("confirmation", "Confirm temporary password", true)}
                  </>
                )}
              </FieldGroup>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Restore options</CardTitle>
            </CardHeader>
            <CardContent>
              <Field className="flex-row items-center justify-between">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <FieldLabel className="font-strong text-label" htmlFor="restore-start">
                    Start the server after restoring
                  </FieldLabel>{" "}
                  <p id="restore-start-description" className="m-0 text-detail text-muted-foreground">
                    An installed service keeps its supervision and login setting. Otherwise, the host tool runs the
                    restored server with a compatible binary.
                  </p>
                </div>
                <Switch
                  id="restore-start"
                  aria-describedby="restore-start-description"
                  checked={draft.start}
                  disabled={busy}
                  onCheckedChange={(value) => configuration.setFieldValue("start", value)}
                />
              </Field>
            </CardContent>
          </Card>
        </form>
      </BackupWorkflow>
    );
  return (
    <BackupWorkflow
      title="Restore Your Server"
      description="Choose a backup, configure the restore, and review it before preparing."
      footer={
        <>
          <span />
          <Button disabled={configureDisabled} onClick={() => setStep("configure")}>
            Configure backup
          </Button>
        </>
      }
    >
      <Field>
        <FieldLabel className="font-strong text-label">Restore from</FieldLabel>
        <RadioGroup
          aria-label="Restore from"
          value={source}
          disabled={busy}
          onValueChange={(value) => {
            setSource(value === "saved" ? "saved" : "file");
            void resetSelection().catch((error) => setSelectionProblem(String(error)));
          }}
        >
          <Field className="flex-row items-center gap-2">
            <RadioGroupItem id="backup-source-file" value="file" />
            <FieldLabel htmlFor="backup-source-file" className="font-strong text-label">
              Open a backup file
            </FieldLabel>
          </Field>
          <Field className="flex-row items-center gap-2">
            <RadioGroupItem id="backup-source-saved" value="saved" />
            <FieldLabel htmlFor="backup-source-saved" className="font-strong text-label">
              Use a saved backup
            </FieldLabel>
          </Field>
        </RadioGroup>
      </Field>
      <form
        id="select-restore-form"
        onSubmit={(event) => {
          event.preventDefault();
          void inspectForm.handleSubmit();
        }}
        className="flex flex-col gap-4"
      >
        {source === "file" ? (
          <Field>
            <Input
              ref={picker}
              id="restore-archive"
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-label="Backup file"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                if (!file) return;
                const values = { file, path: "", password: "", encrypted: false };
                inspectForm.reset(values, { keepDefaultValues: true });
                void validateSelection(values);
              }}
            />
            <Button type="button" variant="outline" disabled={busy} onClick={() => picker.current?.click()}>
              Choose backup file…
            </Button>
            {selected.file && <p className="break-words text-muted-foreground">{selected.file.name}</p>}
          </Field>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Available backups</CardTitle>
            </CardHeader>
            <CardContent>
              <Field>
                <FieldLabel className="sr-only" htmlFor="saved-backup">
                  Available backups
                </FieldLabel>
                <Select
                  id="saved-backup-select"
                  disabled={busy || !restore.saved.data?.backups.length}
                  value={selected.path || null}
                  items={(restore.saved.data?.backups ?? []).map((file) => ({
                    value: file.path,
                    label: `${new Date(file.createdAt).toLocaleString()} · ${file.name}`,
                  }))}
                  onValueChange={(path) => {
                    if (!path) return;
                    const values = { file: null, path, password: "", encrypted: false };
                    inspectForm.reset(values, { keepDefaultValues: true });
                    void validateSelection(values);
                  }}
                >
                  <SelectTrigger id="saved-backup">
                    <SelectValue placeholder="Select a backup" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(restore.saved.data?.backups ?? []).map((file) => (
                        <SelectItem key={file.path} value={file.path}>
                          {new Date(file.createdAt).toLocaleString()} · {file.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {restore.saved.isPending ? (
                  <p className="text-muted-foreground">Loading saved backups…</p>
                ) : !restore.saved.data?.backups.length && !restore.saved.error ? (
                  <p className="text-muted-foreground">No saved backups are available. Open a backup file instead.</p>
                ) : null}
                {restore.saved.error && <BackupError message={restore.saved.error.message} />}
                {selected.path && (
                  <p className="break-words text-muted-foreground">
                    {restore.saved.data?.backups.find((file) => file.path === selected.path)?.name}
                  </p>
                )}
              </Field>
            </CardContent>
          </Card>
        )}
        {selected.encrypted && (
          <inspectForm.Field name="password">
            {(field) => {
              const problem =
                !busy && focusedField !== "password"
                  ? (passwordProblem ?? (field.state.meta.isTouched ? fieldError(field.state.meta.errors) : null))
                  : null;
              return (
                <Field data-invalid={!!problem}>
                  <FieldLabel className="font-strong text-label" htmlFor="restore-password">
                    Archive password
                  </FieldLabel>
                  <Input
                    id="restore-password"
                    type="password"
                    required
                    maxLength={4096}
                    autoComplete="off"
                    disabled={busy}
                    value={field.state.value}
                    aria-invalid={!!problem}
                    aria-describedby={problem ? "restore-password-error" : undefined}
                    onFocus={() => setFocusedField("password")}
                    onBlur={() => {
                      field.handleBlur();
                      setFocusedField(null);
                    }}
                    onChange={(event) => {
                      field.handleChange(event.target.value);
                      setInspection(null);
                      setPasswordProblem(null);
                    }}
                  />
                  {problem && (
                    <p id="restore-password-error" role="alert" className="text-detail text-warning">
                      {problem}
                    </p>
                  )}
                </Field>
              );
            }}
          </inspectForm.Field>
        )}
        {selectionProblem && (
          <p role="alert" className="text-warning">
            {selectionProblem}
          </p>
        )}
        {restore.inspect.isPending && (
          <p role="status" className="flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Validating backup…
          </p>
        )}
        {inspection ? (
          <p role="status" className="m-0 text-body text-success">
            Backup validated. Select Configure backup to continue.
          </p>
        ) : (
          (selected.file || selected.path) && (
            <Button type="submit" variant="outline" disabled={inspectDisabled}>
              {restore.inspect.isPending && (
                <LoaderCircle data-icon="inline-start" className="animate-spin" aria-hidden="true" />
              )}
              Validate backup
            </Button>
          )
        )}
        {source === "file" && (
          <p className="text-muted-foreground">
            Browser uploads support archives up to 128 MB. Use the CLI or desktop assistant for larger files.
          </p>
        )}
      </form>
    </BackupWorkflow>
  );
}
