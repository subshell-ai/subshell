import { Frame } from "@internal/assistant";
import { BACKUP_RESTORE_DEFAULTS, BACKUP_RESTORE_MODES } from "@internal/subshell-protocol";
import { open, save } from "@tauri-apps/plugin-dialog";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import type { RestoreInspection, RestorePrepare } from "../lib/ipc";
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
  const [stages, setStages] = useState<RestoreInspection[]>([]);
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
      .restoreStages()
      .then((result) => {
        if (live) setStages(result.stages.filter((stage) => stage.prepared));
      })
      .catch((error: unknown) => {
        if (live) setProblem(String(error));
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
  const selectStage = async (id: string) => {
    const value = await ipc.restoreInspect("", id, "");
    setStageId(id);
    setInspection(value);
    setReplace(false);
    setForce(false);
    clearPasswords();
  };
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
  const inspect = async () => {
    await act("Inspecting archive checksums and administrators…", async () => {
      const path = await open({
        title: "Open instance backup or database-only snapshot",
        multiple: false,
        directory: false,
      });
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
                {field("password", "Archive password (only for encrypted archives)", true)}
                <Button variant="outline" disabled={locked} onClick={() => void inspect()}>
                  Open and inspect archive…
                </Button>
                {stages.length > 0 && (
                  <div>
                    <Label htmlFor="restore-prepared">Prepared local restores</Label>
                    <select
                      id="restore-prepared"
                      disabled={locked}
                      value={stageId}
                      onChange={(e) => void act("Reading prepared restore…", () => selectStage(e.currentTarget.value))}
                    >
                      <option value="">Choose a prepared restore</option>
                      {stages.map((stage) => (
                        <option key={stage.id} value={stage.id}>
                          {new Date(stage.manifest.completedAt).toLocaleString()} ·{" "}
                          {BACKUP_RESTORE_MODES.find((mode) => mode.value === stage.choices?.mode)?.label ??
                            "Prepared restore"}
                        </option>
                      ))}
                    </select>
                  </div>
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
                          <select
                            id="restore-admin"
                            value={options.recoverAdmin}
                            disabled={locked}
                            onChange={(e) => update("recoverAdmin", e.currentTarget.value)}
                          >
                            <option value="">Select an administrator</option>
                            {inspection.admins.map((admin) => (
                              <option key={admin.id} value={admin.id}>
                                {admin.name} · {admin.email}
                              </option>
                            ))}
                          </select>
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
                          setStages((old) => old.filter((s) => s.id !== stageId));
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
