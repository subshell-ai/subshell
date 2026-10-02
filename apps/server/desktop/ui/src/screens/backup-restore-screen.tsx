import { Frame } from "@internal/assistant";
import { BACKUP_RESTORE_DEFAULTS, BACKUP_RESTORE_MODES } from "@internal/subshell-protocol";
import { open, save } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { LocalBackupFile, RestoreInspection, RestorePrepare } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { RestoreConfirmation, RestoreFacts } from "./restore-confirmation";

export const EMPTY_RESTORE: RestorePrepare = {
  archive: "",
  password: "",
  mode: BACKUP_RESTORE_DEFAULTS.mode,
  dataDir: "",
  databasePath: "",
  configDir: "",
  baseUrl: "",
  host: "",
  port: "",
  trustedOrigins: "",
  recoverAdmin: "",
  temporaryPassword: "",
};
export function passwordProblem(
  password: string,
  confirmation: string,
  enabled: boolean,
  temporary = false,
): string | null {
  if (!enabled) return null;
  if (temporary && password.length < 8) return "Use at least eight characters for the temporary password.";
  if (
    !password ||
    password.includes("\n") ||
    password.includes("\r") ||
    password.includes("\0") ||
    password.length > 4096
  )
    return "Use a password of 1–4096 characters on one line.";
  return password === confirmation ? null : "The passwords do not match.";
}

export function BackupRestoreScreen(props: {
  kind: "backup" | "restore";
  rail?: ReactElement;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onRefresh: () => Promise<unknown>;
  onClose: () => void;
}): ReactElement {
  // Retained only in this mounted window so expired extraction can be repeated.
  const retryPreparation = useRef<RestorePrepare | null>(null);
  const [options, setOptions] = useState<RestorePrepare>({ ...EMPTY_RESTORE });
  const [encrypt, setEncrypt] = useState<boolean>(BACKUP_RESTORE_DEFAULTS.encrypt);
  const [confirmation, setConfirmation] = useState("");
  const [temporaryConfirmation, setTemporaryConfirmation] = useState("");
  const [recover, setRecover] = useState<boolean>(BACKUP_RESTORE_DEFAULTS.recoverAdmin);
  const [start, setStart] = useState<boolean>(BACKUP_RESTORE_DEFAULTS.start);
  const [inspection, setInspection] = useState<RestoreInspection | null>(null);
  const [backups, setBackups] = useState<LocalBackupFile[]>([]);
  const [backupSource, setBackupSource] = useState("file");
  const [selectedBackupPath, setSelectedBackupPath] = useState("");
  const [backupsProblem, setBackupsProblem] = useState("");
  const [stageId, setStageId] = useState("");
  const [replace, setReplace] = useState(false);
  const [sessionConfirmation, setSessionConfirmation] = useState("");
  const [problem, setProblem] = useState("");
  const [message, setMessage] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [showCompletion, setShowCompletion] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{ started: boolean; recoveredAdmin: boolean } | null>(null);
  const [progress, setProgress] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const locked = props.busy || localBusy;
  const update = (name: keyof RestorePrepare, value: string) => {
    const cached = retryPreparation.current;
    retryPreparation.current = null;
    setInspection((old) => old && { ...old, prepared: false });
    if (cached) setTemporaryConfirmation(cached.temporaryPassword);
    setOptions((old) => ({
      ...old,
      password: old.password || cached?.password || "",
      temporaryPassword: old.temporaryPassword || cached?.temporaryPassword || "",
      [name]: value,
    }));
    setReplace(false);
  };
  const clearPasswords = () => {
    setOptions((old) => ({ ...old, password: "", temporaryPassword: "" }));
    setConfirmation("");
    setTemporaryConfirmation("");
  };
  const act = async (label: string, fn: () => Promise<void>) => {
    if (locked) return;
    setLocalBusy(true);
    props.onBusy(true);
    setProblem("");
    setProgress(label);
    setMessage("");
    try {
      await fn();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setProgress("");
      setLocalBusy(false);
      props.onBusy(false);
    }
  };
  useEffect(() => {
    if (props.kind !== "restore") return;
    let live = true;
    void ipc
      .backupList()
      .then((result) => {
        if (live) setBackups(result.backups);
      })
      .catch((error: unknown) => {
        if (live) setBackupsProblem(String(error));
      });
    return () => {
      live = false;
    };
  }, [props.kind]);
  const field = (name: keyof RestorePrepare, label: string, password = false) => (
    <div key={name}>
      <Label htmlFor={`restore-${name}`}>{label}</Label>
      <Input
        id={`restore-${name}`}
        type={password ? "password" : "text"}
        autoComplete={password ? "new-password" : "off"}
        spellCheck={false}
        disabled={locked}
        value={options[name]}
        onChange={(event) => update(name, event.currentTarget.value)}
      />
    </div>
  );
  const toggle = (
    id: string,
    label: string,
    checked: boolean,
    change: (checked: boolean) => void,
    disabled = locked,
  ) => (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={change} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
  const backup = async () => {
    const failure = passwordProblem(options.password, confirmation, encrypt);
    if (failure) {
      setProblem(failure);
      return;
    }
    await act("Creating a consistent instance archive…", async () => {
      const path = await save({
        title: "Save instance backup",
        defaultPath: `subshell-instance-${new Date().toISOString().slice(0, 10)}.subshell`,
        filters: [{ name: "Subshell instance archive", extensions: ["subshell"] }],
      });
      if (!path) {
        clearPasswords();
        return;
      }
      try {
        const result = await ipc.backup(path, encrypt ? options.password : "");
        setMessage(`Backup saved to ${result.path} (${result.bytes.toLocaleString()} bytes).`);
      } finally {
        clearPasswords();
      }
    });
  };
  const inspect = async (selectedPath?: string) => {
    await act("Inspecting archive checksums and administrators…", async () => {
      const path =
        selectedPath ??
        (await open({
          title: "Open instance backup or database-only snapshot",
          multiple: false,
          directory: false,
        }));
      if (typeof path !== "string") return;
      retryPreparation.current = null;
      setStageId("");
      setInspection(null);
      setReplace(false);
      setSessionConfirmation("");
      update("archive", path);
      try {
        const value = await ipc.restoreInspect(path, "", options.password);
        if (value.legacyDatabaseOnly) {
          setOptions((old) => ({
            ...old,
            mode: BACKUP_RESTORE_DEFAULTS.mode,
            dataDir: "",
            databasePath: "",
            configDir: "",
            baseUrl: "",
            host: "",
            port: "",
            trustedOrigins: "",
          }));
        } else {
          const defaults = value.choices?.configOverrides;
          setOptions((old) => ({
            ...old,
            databasePath: value.destination?.databasePath ?? "",
            dataDir: value.destination?.dataDir ?? "",
            configDir: value.destination?.configPath.replace(/[/\\][^/\\]+$/, "") ?? "",
            baseUrl: String(defaults?.baseUrl ?? ""),
            host: String(defaults?.host ?? ""),
            port: String(defaults?.port ?? ""),
            trustedOrigins: String(defaults?.trustedOrigins ?? ""),
          }));
        }
        setStageId(value.id ?? "");
        setInspection(value);
      } catch (error) {
        clearPasswords();
        throw error;
      }
    });
  };
  const prepare = async () => {
    const failure = passwordProblem(options.temporaryPassword, temporaryConfirmation, recover, true);
    if (failure) {
      throw new Error(failure);
    }
    if (recover && !options.recoverAdmin) {
      throw new Error("Choose an existing administrator from the archive.");
    }
    try {
      const request: RestorePrepare = {
        ...options,
        ...(!inspection?.legacyDatabaseOnly && {
          databasePath: options.databasePath || inspection?.destination?.databasePath || "",
          dataDir: options.dataDir || inspection?.destination?.dataDir || "",
          configDir: options.configDir || inspection?.destination?.configPath.replace(/[/\\][^/\\]+$/, "") || "",
          baseUrl: options.baseUrl || String(inspection?.choices?.configOverrides?.baseUrl ?? ""),
          host: options.host || String(inspection?.choices?.configOverrides?.host ?? ""),
          port: options.port || String(inspection?.choices?.configOverrides?.port ?? ""),
          trustedOrigins: options.trustedOrigins || String(inspection?.choices?.configOverrides?.trustedOrigins ?? ""),
        }),
        recoverAdmin: recover ? options.recoverAdmin : "",
        temporaryPassword: recover ? options.temporaryPassword : "",
      };
      const result = await ipc.restorePrepare(request);
      retryPreparation.current = request;
      setInspection(result);
      setStageId(result.id ?? "");
      return result;
    } finally {
      clearPasswords();
    }
  };
  const apply = async (force = false) => {
    if (!replace) return;
    await act("Preparing the backup for restore…", async () => {
      setRestoring(true);
      try {
        let reviewed = inspection;
        let currentId = stageId;
        if (!retryPreparation.current && !reviewed?.prepared) {
          const result = await prepare();
          if (JSON.stringify(result.manifest) !== JSON.stringify(inspection?.manifest)) {
            setReplace(false);
            throw new Error("The backup changed. Review it again before restoring.");
          }
          reviewed = result;
          currentId = result.id ?? "";
        }
        const refreshStage = async () => {
          if (!retryPreparation.current || !inspection) throw new Error("Choose the backup again to prepare it.");
          setProgress("Refreshing the backup extraction…");
          const refreshed = await ipc.restorePrepare(retryPreparation.current);
          setInspection(refreshed);
          setStageId(refreshed.id ?? "");
          if (
            JSON.stringify(refreshed.manifest) !== JSON.stringify(reviewed?.manifest) ||
            JSON.stringify(refreshed.destination) !== JSON.stringify(reviewed?.destination) ||
            JSON.stringify(refreshed.choices) !== JSON.stringify(reviewed?.choices) ||
            refreshed.recoveryUserId !== reviewed?.recoveryUserId
          ) {
            setReplace(false);
            setSessionConfirmation("");
            throw new Error("The backup or restore settings changed. Review the refreshed restore before continuing.");
          }
          currentId = refreshed.id ?? "";
        };
        if (reviewed?.expiresAt && reviewed.expiresAt <= Date.now()) await refreshStage();
        setProgress(start ? "Restoring your server and verifying it starts…" : "Restoring your server…");
        let result;
        try {
          result = await ipc.restoreApply(currentId, replace, force, start);
        } catch (error) {
          if (!String(error).includes("Restore upload expired.")) throw error;
          await refreshStage();
          result = await ipc.restoreApply(currentId, replace, force, start);
        }
        retryPreparation.current = null;
        setRestoreResult({ started: result.started, recoveredAdmin: recover });
        setMessage(
          result.started
            ? "Restore completed. The restored server confirmed a successful boot."
            : "Restore applied. The server remains stopped; previous state is retained until its next successful boot.",
        );
        setInspection(null);
        setStageId("");
        setReplace(false);
        setSessionConfirmation("");
        await props.onRefresh();
      } catch (error) {
        const detail = String(error);
        const marker = "RESTORE_SESSION_CONFIRMATION_REQUIRED:";
        if (!detail.includes(marker)) throw error;
        setSessionConfirmation(detail.slice(detail.indexOf(marker) + marker.length).trim());
      } finally {
        setRestoring(false);
        clearPasswords();
      }
    });
  };
  if (props.kind === "restore" && (restoring || restoreResult)) {
    const completion = showCompletion ? restoreResult : null;
    return (
      <Frame
        rail={props.rail}
        strings={{
          title: completion ? "Restore Complete" : "Restoring Your Server",
          subtitle: completion
            ? "Your backup has been restored."
            : restoreResult
              ? "The restore has finished. Select Next when you’re ready."
              : "Please keep this app open until the restore finishes.",
          problem,
        }}
        barRight={
          completion ? (
            <Button disabled={locked} onClick={props.onClose}>
              Done
            </Button>
          ) : restoreResult ? (
            <Button disabled={locked} onClick={() => setShowCompletion(true)}>
              Next
            </Button>
          ) : (
            <Button disabled>Restoring…</Button>
          )
        }
      >
        <Card role="status" aria-live="polite">
          <CardHeader>
            <div className="flex items-center gap-3">
              {restoreResult ? (
                <CheckCircle2 className="size-6 shrink-0 text-primary" aria-hidden="true" />
              ) : (
                <LoaderCircle className="size-6 shrink-0 animate-spin text-primary" aria-hidden="true" />
              )}
              <CardTitle>
                {completion
                  ? completion.started
                    ? "Your server is ready"
                    : "Your server is stopped"
                  : restoreResult
                    ? "Restore finished"
                    : progress}
              </CardTitle>
            </div>
            <CardDescription>
              {completion
                ? message
                : restoreResult
                  ? "Select Next to review the restore result."
                  : "The server may be temporarily unavailable while its saved state is replaced."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {completion ? (
              <p className="text-body text-muted-foreground">
                {completion.started
                  ? completion.recoveredAdmin
                    ? "Open the dashboard and sign in with the recovered administrator’s temporary password."
                    : "Open the dashboard and sign in with an account from the backup."
                  : "Start the server from the Service page when you’re ready. The restore will be verified on its next successful start."}
              </p>
            ) : (
              <ul className="flex flex-col gap-2 list-disc pl-5 text-body text-muted-foreground">
                <li>The backup is prepared and checked before replacement.</li>
                <li>The server is stopped, its saved state is restored, and compatible sessions are preserved.</li>
                {start && <li>The server is restarted and checked before success is confirmed.</li>}
                <li>When the restore finishes, select Next to review the result.</li>
              </ul>
            )}
          </CardContent>
        </Card>
      </Frame>
    );
  }
  const [sessionSummary, ...sessionConsequences] = sessionConfirmation.split(/(?<=\.)\s+/);
  const sessionCount = sessionSummary?.match(/^(\d+ active sessions?)(.*)$/);
  const selectedBackup = backups.find((file) => file.path === selectedBackupPath);
  const backupLabel = (file: LocalBackupFile) =>
    `${new Date(file.createdAt).toLocaleString()} · ${file.legacyDatabaseOnly ? "Database-only snapshot" : "Full instance archive"}${file.serverVersion ? ` · Server ${file.serverVersion}` : ""}`;
  return (
    <Frame
      rail={props.rail}
      strings={{
        title: props.kind === "backup" ? "Back Up Your Server" : inspection ? "Review Restore" : "Restore Your Server",
        subtitle:
          props.kind === "backup"
            ? "Save the database, supported configuration, identity, plugins and captured logs."
            : inspection
              ? "Review the destination and restore options before replacing your server’s state."
              : "Restore an instance even when its server is stopped or has never been configured.",
        problem,
      }}
      barLeft={
        inspection ? (
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() =>
              void act("Returning to backup selection…", async () => {
                if (stageId) await ipc.restoreDiscard(stageId);
                retryPreparation.current = null;
                setInspection(null);
                setStageId("");
                setReplace(false);
                setSessionConfirmation("");
                clearPasswords();
              })
            }
          >
            Back
          </Button>
        ) : props.rail === undefined ? (
          <Button variant="ghost" disabled={locked} onClick={props.onClose}>
            Back
          </Button>
        ) : undefined
      }
      barRight={
        props.kind === "backup" ? (
          <Button disabled={locked} onClick={() => void backup()}>
            Save backup…
          </Button>
        ) : inspection ? (
          <Button disabled={locked || !replace} onClick={() => void apply()}>
            Restore
          </Button>
        ) : (
          <Button
            disabled={locked || (backupSource === "saved" && !selectedBackup)}
            onClick={() => void inspect(backupSource === "saved" ? selectedBackup?.path : undefined)}
          >
            Review backup
          </Button>
        )
      }
    >
      {sessionConfirmation && (
        <Dialog title="Some sessions cannot survive this restore" onClose={() => !locked && setSessionConfirmation("")}>
          <p className="text-muted-foreground break-words">
            {sessionCount ? (
              <>
                <span className="text-warning font-strong">{sessionCount[1]}</span>
                {sessionCount[2]}
              </>
            ) : (
              sessionSummary
            )}
          </p>
          <ul className="mt-3 flex flex-col gap-2 list-disc pl-5 text-muted-foreground">
            {sessionConsequences.map((consequence) => (
              <li key={consequence}>{consequence}</li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" disabled={locked} onClick={() => setSessionConfirmation("")}>
              Cancel
            </Button>
            <Button
              disabled={locked}
              onClick={() => {
                setSessionConfirmation("");
                void apply(true);
              }}
            >
              Continue restore
            </Button>
          </div>
        </Dialog>
      )}
      <div className="flex flex-col gap-4">
        {progress && (
          <p className="hint" role="status">
            {progress}
          </p>
        )}
        {message && (
          <p className="hint" role="status">
            {message}
          </p>
        )}
        {props.kind === "backup" ? (
          <>
            {toggle("backup-encrypt", "Encrypt the archive with a password", encrypt, setEncrypt)}
            {encrypt && (
              <>
                {field("password", "Archive password", true)}
                <div>
                  <Label htmlFor="backup-confirmation">Confirm archive password</Label>
                  <Input
                    id="backup-confirmation"
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    disabled={locked}
                    onChange={(e) => setConfirmation(e.currentTarget.value)}
                  />
                </div>
              </>
            )}
          </>
        ) : (
          <>
            {!inspection && (
              <>
                {backups.length > 0 && (
                  <FieldSet>
                    <FieldLegend id="backup-source-label">Restore from</FieldLegend>
                    <RadioGroup
                      aria-labelledby="backup-source-label"
                      value={backupSource}
                      disabled={locked}
                      onValueChange={(value) => {
                        retryPreparation.current = null;
                        setBackupSource(value === "saved" ? "saved" : "file");
                        setInspection(null);
                        setStageId("");
                        setReplace(false);
                        setSessionConfirmation("");
                        setRecover(false);
                        setOptions({ ...EMPTY_RESTORE });
                        setConfirmation("");
                        setTemporaryConfirmation("");
                        setProblem("");
                      }}
                    >
                      <Field orientation="horizontal" data-disabled={locked}>
                        <RadioGroupItem id="backup-source-file" value="file" />
                        <FieldLabel htmlFor="backup-source-file">Open a backup file</FieldLabel>
                      </Field>
                      <Field orientation="horizontal" data-disabled={locked}>
                        <RadioGroupItem id="backup-source-saved" value="saved" />
                        <FieldLabel htmlFor="backup-source-saved">Use a saved backup</FieldLabel>
                      </Field>
                    </RadioGroup>
                  </FieldSet>
                )}
                {(backupSource === "file" || (selectedBackup && !selectedBackup.legacyDatabaseOnly)) &&
                  field("password", "Archive password (only for encrypted archives)", true)}
                {backupsProblem && (
                  <p className="m-0 text-detail text-destructive" role="alert">
                    Could not load saved backups. You can still open a backup file.
                  </p>
                )}
                {backupSource === "saved" && backups.length > 0 && (
                  <Card aria-labelledby="available-backups-title">
                    <CardHeader>
                      <CardTitle id="available-backups-title">Available backups</CardTitle>
                      <CardDescription>
                        Backups saved on this server, including archives made before upgrades.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-col gap-3">
                        <Select
                          value={selectedBackupPath || null}
                          disabled={locked}
                          items={backups.map((file) => ({ value: file.path, label: backupLabel(file) }))}
                          onValueChange={(path) => setSelectedBackupPath(path ?? "")}
                        >
                          <SelectTrigger aria-label="Available backup">
                            <SelectValue placeholder="Choose a backup" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {backups.map((file) => (
                                <SelectItem key={file.path} value={file.path}>
                                  {backupLabel(file)}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {selectedBackup && (
                          <p className="m-0 break-words text-detail text-muted-foreground [overflow-wrap:anywhere]">
                            {selectedBackup.name} ·{" "}
                            {(selectedBackup.bytes / 1024 / 1024).toLocaleString(undefined, {
                              maximumFractionDigits: 1,
                            })}{" "}
                            MB{selectedBackup.encrypted ? " · Encrypted" : ""}
                          </p>
                        )}
                      </div>
                      {backups.some((file) => file.legacyDatabaseOnly) && (
                        <p className="m-0 mt-3 text-detail text-muted-foreground">
                          Database-only snapshots restore the database and keep current configuration and identity
                          files. Older databases are migrated when the server starts.
                        </p>
                      )}
                    </CardContent>
                  </Card>
                )}
              </>
            )}
            {inspection && (
              <>
                {inspection && (
                  <Card aria-labelledby="backup-details-title">
                    <CardHeader>
                      <CardTitle id="backup-details-title">Backup details</CardTitle>
                      <CardDescription>
                        {inspection.legacyDatabaseOnly ? "Database-only snapshot" : "Full instance archive"}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      <RestoreFacts
                        rows={[
                          ["Captured", new Date(inspection.manifest.completedAt).toLocaleString()],
                          [
                            "Server version",
                            inspection.manifest.serverVersion === "legacy"
                              ? "Unknown (not recorded in this snapshot)"
                              : inspection.manifest.serverVersion,
                          ],
                          [
                            "Administrators",
                            inspection.admins.map((admin) => `${admin.name} (${admin.email})`).join(", ") ||
                              "None recorded",
                          ],
                        ]}
                      />
                      {inspection.legacyDatabaseOnly && (
                        <p className="m-0 text-detail text-muted-foreground">
                          Restores the database using this server’s current configuration and identity.
                        </p>
                      )}
                    </CardContent>
                  </Card>
                )}
                {inspection && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Restore settings</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      <FieldSet>
                        <FieldLegend id="restore-mode-label">Restore mode</FieldLegend>
                        <RadioGroup
                          aria-labelledby="restore-mode-label"
                          aria-describedby={inspection.legacyDatabaseOnly ? "restore-mode-description" : undefined}
                          name="restore-mode"
                          value={options.mode}
                          disabled={locked || inspection.legacyDatabaseOnly}
                          onValueChange={(value) => update("mode", value)}
                        >
                          {BACKUP_RESTORE_MODES.map((mode) => (
                            <Field
                              key={mode.value}
                              orientation="horizontal"
                              data-disabled={locked || inspection.legacyDatabaseOnly}
                            >
                              <RadioGroupItem id={`restore-mode-${mode.value}`} value={mode.value} />
                              <FieldLabel htmlFor={`restore-mode-${mode.value}`}>{mode.label}</FieldLabel>
                            </Field>
                          ))}
                        </RadioGroup>
                        {inspection.legacyDatabaseOnly && (
                          <p id="restore-mode-description" className="hint">
                            This older backup contains only the database, so restore modes are unavailable. It restores
                            into this server using its current configuration and identity. Moving to a new machine
                            requires a full instance archive.
                          </p>
                        )}
                      </FieldSet>
                      {inspection.legacyDatabaseOnly && inspection.destination && (
                        <div className="flex flex-col gap-2">
                          <h3 className="m-0 text-label font-strong">Destination</h3>
                          <RestoreFacts rows={[["Database", inspection.destination.databasePath]]} />
                        </div>
                      )}
                      {!inspection.legacyDatabaseOnly && (
                        <>
                          <h3 className="m-0 text-label font-strong">Destination</h3>
                          {options.mode === "migration" && (
                            <p className="hint">
                              Supported identity is preserved. Network publication is disabled until you review it on
                              this machine.
                            </p>
                          )}
                          <p className="hint">Values are filled from the backup. Change them to restore elsewhere.</p>
                          {field("databasePath", "Destination database path (optional)")}
                          {field("dataDir", "Destination data directory (optional)")}
                          {field("configDir", "Destination configuration directory (optional)")}
                          {field("baseUrl", "Public base URL (optional)")}
                          {field("host", "Listen address (optional)")}
                          {field("port", "Port (optional)")}
                          {field("trustedOrigins", "Trusted origins (optional)")}
                        </>
                      )}
                      {toggle("restore-recovery", "Recover an existing administrator", recover, (checked) => {
                        update("password", options.password || retryPreparation.current?.password || "");
                        setRecover(checked);
                      })}
                      {recover && (
                        <>
                          <p className="hint warn-text">
                            Email/password authentication will be enabled. This administrator must change the temporary
                            password after signing in.
                          </p>
                          <div>
                            <Label htmlFor="restore-admin">Administrator</Label>
                            <Select
                              value={options.recoverAdmin || null}
                              disabled={locked}
                              items={inspection.admins.map((admin) => ({
                                value: admin.id,
                                label: `${admin.name} · ${admin.email}`,
                              }))}
                              onValueChange={(id) => update("recoverAdmin", id ?? "")}
                            >
                              <SelectTrigger id="restore-admin">
                                <SelectValue placeholder="Select an administrator" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {inspection.admins.map((admin) => (
                                    <SelectItem key={admin.id} value={admin.id}>
                                      {admin.name} · {admin.email}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </div>
                          {field("temporaryPassword", "Temporary password (at least eight characters)", true)}
                          <div>
                            <Label htmlFor="restore-temporary-confirmation">Confirm temporary password</Label>
                            <Input
                              id="restore-temporary-confirmation"
                              type="password"
                              autoComplete="new-password"
                              disabled={locked}
                              value={temporaryConfirmation}
                              onChange={(e) => setTemporaryConfirmation(e.currentTarget.value)}
                            />
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>
                )}
                {inspection && (
                  <RestoreConfirmation
                    locked={locked}
                    replace={replace}
                    start={start}
                    setReplace={setReplace}
                    setStart={setStart}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </Frame>
  );
}
