import { Frame } from "@internal/assistant";
import { BACKUP_RESTORE_DEFAULTS, BACKUP_RESTORE_MODES } from "@internal/subshell-protocol";
import { open, save } from "@tauri-apps/plugin-dialog";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { LocalBackupFile, RestoreInspection, RestorePrepare } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { RestoreConfirmation } from "./restore-confirmation";

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
  const [force, setForce] = useState(false);
  const [problem, setProblem] = useState("");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const locked = props.busy || localBusy;
  const prepared = inspection?.prepared === true;
  const update = (name: keyof RestorePrepare, value: string) => setOptions((old) => ({ ...old, [name]: value }));
  const clearPasswords = () => {
    update("password", "");
    update("temporaryPassword", "");
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
        disabled={locked || prepared}
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
      setStageId("");
      setInspection(null);
      setReplace(false);
      setForce(false);
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
      setProblem(failure);
      return;
    }
    if (recover && !options.recoverAdmin) {
      setProblem("Choose an existing administrator from the archive.");
      return;
    }
    await act("Validating destination and preparing recovery before stopping the server…", async () => {
      try {
        const result = await ipc.restorePrepare({
          ...options,
          ...(!inspection?.legacyDatabaseOnly && {
            databasePath: options.databasePath || inspection?.destination?.databasePath || "",
            dataDir: options.dataDir || inspection?.destination?.dataDir || "",
            configDir: options.configDir || inspection?.destination?.configPath.replace(/[/\\][^/\\]+$/, "") || "",
            baseUrl: options.baseUrl || String(inspection?.choices?.configOverrides?.baseUrl ?? ""),
            host: options.host || String(inspection?.choices?.configOverrides?.host ?? ""),
            port: options.port || String(inspection?.choices?.configOverrides?.port ?? ""),
            trustedOrigins:
              options.trustedOrigins || String(inspection?.choices?.configOverrides?.trustedOrigins ?? ""),
          }),
          recoverAdmin: recover ? options.recoverAdmin : "",
          temporaryPassword: recover ? options.temporaryPassword : "",
        });
        setInspection(result);
        setStageId(result.id ?? "");
        setReplace(false);
        setForce(false);
      } finally {
        clearPasswords();
      }
    });
  };
  const apply = async () => {
    if (!replace) return;
    await act("Restoring the instance and waiting for its successful boot…", async () => {
      try {
        const result = await ipc.restoreApply(stageId, replace, force, start);
        setMessage(
          result.started
            ? "Restore completed. The restored server confirmed a successful boot."
            : "Restore applied. The server remains stopped; previous state is retained until its next successful boot.",
        );
        setInspection(null);
        setStageId("");
        setReplace(false);
        setForce(false);
        await props.onRefresh();
      } finally {
        clearPasswords();
      }
    });
  };
  const selectedBackup = backups.find((file) => file.path === selectedBackupPath);
  const backupLabel = (file: LocalBackupFile) =>
    `${new Date(file.createdAt).toLocaleString()} · ${file.legacyDatabaseOnly ? "Database-only snapshot" : "Full instance archive"}${file.serverVersion ? ` · Server ${file.serverVersion}` : ""}`;
  return (
    <Frame
      rail={props.rail}
      strings={{
        title: props.kind === "backup" ? "Back Up Your Server" : prepared ? "Review Restore" : "Restore Your Server",
        subtitle:
          props.kind === "backup"
            ? "Save the database, supported configuration, identity, plugins and captured logs."
            : prepared
              ? "Review the destination and restore options before replacing your server’s state."
              : "Restore an instance even when its server is stopped or has never been configured.",
        problem,
      }}
      barLeft={
        props.rail === undefined && (
          <Button variant="ghost" disabled={locked} onClick={props.onClose}>
            Back
          </Button>
        )
      }
      barRight={
        props.kind === "backup" ? (
          <Button disabled={locked} onClick={() => void backup()}>
            Save backup…
          </Button>
        ) : prepared ? (
          <Button disabled={locked || !replace} onClick={() => void apply()}>
            Restore
          </Button>
        ) : (
          inspection && (
            <Button disabled={locked} onClick={() => void prepare()}>
              Review replacement
            </Button>
          )
        )
      }
    >
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
            <p className="hint">
              Full archives include supported configuration secrets, identity keys and plugin-owned secrets. They
              exclude external agent credentials, projects, user uploads, remote-node state, running processes, tmux
              sockets, executable cache files and OS state. A restored instance retires old pane records.
            </p>
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
            {!prepared && (
              <>
                {backups.length > 0 && (
                  <FieldSet>
                    <FieldLegend id="backup-source-label">Restore from</FieldLegend>
                    <RadioGroup
                      aria-labelledby="backup-source-label"
                      value={backupSource}
                      disabled={locked}
                      onValueChange={(value) => {
                        setBackupSource(value === "saved" ? "saved" : "file");
                        setInspection(null);
                        setStageId("");
                        setReplace(false);
                        setForce(false);
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
                {backupSource === "file" && (
                  <Button variant="outline" disabled={locked} onClick={() => void inspect()}>
                    Open and inspect archive…
                  </Button>
                )}
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
                        Backups saved on this server, including database snapshots made before upgrades.
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
                        <Button
                          variant="outline"
                          disabled={locked || !selectedBackup}
                          onClick={() => {
                            if (selectedBackup) void inspect(selectedBackup.path);
                          }}
                        >
                          Inspect selected backup
                        </Button>
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
                {!prepared && (
                  <>
                    <p className="hint">
                      {inspection.legacyDatabaseOnly
                        ? "Database-only snapshot: configuration, identity, plugins and logs are absent."
                        : "Full instance archive"}{" "}
                      · Captured {inspection.manifest.completedAt} · Server {inspection.manifest.serverVersion}
                    </p>
                    <p className="hint">
                      Administrators:{" "}
                      {inspection.admins.map((admin) => `${admin.name} (${admin.email})`).join(", ") || "None recorded"}
                      .
                    </p>
                  </>
                )}
                {!prepared && (
                  <>
                    <FieldSet>
                      <FieldLegend id="restore-mode-label">Restore mode</FieldLegend>
                      <RadioGroup
                        aria-labelledby="restore-mode-label"
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
                    </FieldSet>
                    {!inspection.legacyDatabaseOnly && (
                      <>
                        {options.mode === "migration" && (
                          <p className="hint">
                            Supported identity is preserved. Network publication is disabled until you review it on this
                            machine.
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
                    {toggle("restore-recovery", "Recover an existing administrator", recover, setRecover)}
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
                  </>
                )}
                {prepared && (
                  <>
                    <RestoreConfirmation
                      inspection={inspection}
                      locked={locked}
                      replace={replace}
                      force={force}
                      start={start}
                      setReplace={setReplace}
                      setForce={setForce}
                      setStart={setStart}
                    />
                    <Button
                      variant="ghost"
                      disabled={locked}
                      onClick={() =>
                        void act("Discarding prepared restore…", async () => {
                          await ipc.restoreDiscard(stageId);
                          setInspection(null);
                          setStageId("");
                        })
                      }
                    >
                      Discard prepared restore
                    </Button>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Frame>
  );
}
