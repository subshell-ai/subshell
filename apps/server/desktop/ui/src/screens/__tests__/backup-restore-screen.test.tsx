import { afterEach, describe, expect, it } from "bun:test";
import { BACKUP_RESTORE_DEFAULTS } from "@internal/subshell-protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type FakeIpc, installFakeIpc, makeProbe } from "../../__tests__/harness";
import { route } from "../../lib/server-state";
import { BackupRestoreScreen, EMPTY_RESTORE, passwordProblem } from "../backup-restore-screen";

let fake: FakeIpc | null = null;
afterEach(() => {
  cleanup();
  fake?.restore();
  fake = null;
});
const stage = {
  id: "00000000-0000-0000-0000-000000000000",
  expiresAt: Date.now() + 60000,
  prepared: true,
  choices: { mode: "migration" },
  recoveryUserId: "admin1",
  destination: {
    databasePath: "/tmp/restore/db.sqlite",
    dataDir: "/tmp/restore/data",
    configPath: "/tmp/restore/config/config.env",
  },
  manifest: {
    completedAt: "2026-10-01T00:00:00Z",
    serverVersion: "1.3.4",
    exclusions: ["running processes"],
    entries: [],
  },
  admins: [{ id: "admin1", name: "Administrator", email: "admin@example.com" }],
  legacyDatabaseOnly: false,
};
const props = { busy: false, onBusy: () => {}, onRefresh: async () => {}, onClose: () => {} };

async function reviewSelectedBackup() {
  const choose = screen.queryByRole("button", { name: "Choose backup file…" });
  const validate = screen.queryByRole("button", { name: "Validate backup" });
  const selectionAction = choose ?? validate;
  if (selectionAction) {
    await waitFor(() => expect(selectionAction.hasAttribute("disabled")).toBe(false));
    fireEvent.click(selectionAction);
  }
  const review = screen.getByRole("button", { name: "Review backup" });
  await waitFor(() => expect(review.hasAttribute("disabled")).toBe(false));
  fireEvent.click(review);
}

describe("native backup and restore", () => {
  it("requires successful selection and validation before review and invalidates a changed password", async () => {
    fake = installFakeIpc({
      handlers: {
        desktop_backup_list: () => ({ backups: [] }),
        "plugin:dialog|open": () => "/tmp/validated.subshell",
        desktop_restore_inspect: () => ({ ...stage, prepared: false }),
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    const review = screen.getByRole("button", { name: "Review backup" });
    expect(review.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Choose backup file…" }));
    await screen.findByText("Backup validated. Select Review backup to continue.");
    await waitFor(() => expect(review.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByRole("heading", { name: "Review Restore" })).toBeNull();
    expect(screen.getByText("/tmp/validated.subshell")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Archive password (only for encrypted archives)"), {
      target: { value: "different password" },
    });
    expect(review.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Validate backup" }));
    await waitFor(() => expect(review.hasAttribute("disabled")).toBe(false));
    expect(fake.callsTo("desktop_restore_inspect")[1]?.password).toBe("different password");
    fireEvent.click(review);
    await screen.findByRole("heading", { name: "Review Restore" });
  });

  it("shows backup progress, waits for Next, and confirms the saved archive", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fake = installFakeIpc({
      handlers: {
        "plugin:dialog|save": () => "/tmp/instance.subshell",
        desktop_backup: async () => {
          await pending;
          return { path: "/tmp/instance.subshell", bytes: 4096 };
        },
      },
    });
    render(<BackupRestoreScreen {...props} kind="backup" />);
    fireEvent.click(screen.getByRole("button", { name: "Save backup…" }));
    await screen.findByText("Backing Up Your Server");
    expect(screen.getByRole("button", { name: "Backing up…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save backup…" })).toBeNull();
    finish();
    const next = await screen.findByRole("button", { name: "Next" });
    await waitFor(() => expect(next.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText("Backup Complete")).toBeNull();
    fireEvent.click(next);
    await screen.findByText("Backup Complete");
    expect(screen.getByText("/tmp/instance.subshell")).toBeTruthy();
    expect(screen.getByText("4,096 bytes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Archive" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy Size" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy Encryption" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });
  it("returns to the backup form on failure without showing success", async () => {
    fake = installFakeIpc({
      handlers: {
        "plugin:dialog|save": () => "/tmp/instance.subshell",
        desktop_backup: () => {
          throw new Error("Not enough disk space");
        },
      },
    });
    render(<BackupRestoreScreen {...props} kind="backup" />);
    fireEvent.click(screen.getByRole("button", { name: "Save backup…" }));
    await screen.findByText("Not enough disk space");
    expect(screen.queryByText("Backup Complete")).toBeNull();
    expect(screen.getByRole("button", { name: "Save backup…" })).toBeTruthy();
  });

  it("hides the available backups card when none exist", async () => {
    fake = installFakeIpc({ handlers: { desktop_backup_list: () => ({ backups: [] }) } });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    await waitFor(() => expect(fake?.callsTo("desktop_backup_list")).toHaveLength(1));
    expect(screen.queryByRole("heading", { name: "Available backups" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review backup" })).toBeTruthy();
  });
  it("prefills from the backup, preserves optional defaults when cleared, and submits edits", async () => {
    const configOverrides = {
      baseUrl: "https://backup.example",
      host: "127.0.0.1",
      port: "4567",
      trustedOrigins: "https://backup.example",
    };
    fake = installFakeIpc({
      handlers: {
        desktop_backup_list: () => ({ backups: [] }),
        "plugin:dialog|open": () => "/tmp/backup.subshell",
        desktop_restore_inspect: () => ({
          ...stage,
          prepared: false,
          choices: { mode: "same-machine", configOverrides },
        }),
        desktop_restore_prepare: () => stage,
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    await reviewSelectedBackup();
    await screen.findByLabelText("Destination database path (optional)");
    const expected = {
      "Destination database path (optional)": stage.destination.databasePath,
      "Destination data directory (optional)": stage.destination.dataDir,
      "Destination configuration directory (optional)": "/tmp/restore/config",
      "Public base URL (optional)": configOverrides.baseUrl,
      "Listen address (optional)": configOverrides.host,
      "Port (optional)": configOverrides.port,
      "Trusted origins (optional)": configOverrides.trustedOrigins,
    };
    for (const [label, value] of Object.entries(expected)) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(value);
      fireEvent.change(screen.getByLabelText(label), { target: { value: "" } });
    }
    fireEvent.change(screen.getByLabelText("Public base URL (optional)"), {
      target: { value: "https://edited.example" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Replace the displayed destination" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(fake?.callsTo("desktop_restore_prepare")).toHaveLength(1));
    expect(fake.callsTo("desktop_restore_prepare")[0]?.options).toMatchObject({
      mode: "same-machine",
      databasePath: stage.destination.databasePath,
      dataDir: stage.destination.dataDir,
      configDir: "/tmp/restore/config",
      ...configOverrides,
      baseUrl: "https://edited.example",
    });
  });
  it("matches server UTF-16 password limits for multibyte text and supplementary-plane characters", () => {
    for (const password of ["é".repeat(3000), "😀".repeat(2048), "😀".repeat(4)])
      expect(passwordProblem(password, password, true, true)).toBeNull();
    for (const password of ["é".repeat(4097), "😀".repeat(2049)])
      expect(passwordProblem(password, password, true)).toContain("4096");
    expect(passwordProblem("😀".repeat(3), "😀".repeat(3), true, true)).toContain("eight");
    for (const password of ["line\rbreak", "line\nbreak", "nul\0value"])
      expect(passwordProblem(password, password, true)).toContain("one line");
  });
  it("routes requested doors over first run, stopped and ready without setup", () => {
    for (const next of ["no-server", "init", "start", "ready"] as const) {
      const probe = makeProbe({ next, onboarded: next === "ready" });
      expect(route(probe, "backup", { running: false, failure: null }).kind).toBe("backup");
      expect(route(probe, "restore", { running: false, failure: null }).kind).toBe("restore");
    }
    expect(EMPTY_RESTORE.mode).toBe(BACKUP_RESTORE_DEFAULTS.mode);
    expect(passwordProblem("short", "short", true, true)).toContain("eight");
    expect(passwordProblem("password", "different", true)).toContain("match");
    expect(passwordProblem("line\nbreak", "line\nbreak", true)).toContain("one line");
  });
  it("leaves optional encryption off with password fields hidden", () => {
    render(<BackupRestoreScreen {...props} kind="backup" />);
    expect(
      screen.getByRole("switch", { name: "Encrypt the archive with a password" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.queryByLabelText("Archive password")).toBeNull();
  });
  it("preserves prepared choices and separates replacement from pane consent, start defaults on", async () => {
    fake = installFakeIpc({
      handlers: {
        desktop_backup_list: () => ({
          backups: [
            {
              path: "/tmp/saved.tar.gz",
              name: "saved.tar.gz",
              bytes: 1024,
              createdAt: stage.manifest.completedAt,
              legacyDatabaseOnly: false,
              encrypted: false,
            },
          ],
        }),
        desktop_restore_inspect: () => stage,
        desktop_restore_apply: () => ({ status: "completed", started: true, destination: stage.destination }),
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    expect(screen.queryByRole("heading", { name: "Available backups" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review backup" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("radio", { name: "Use a saved backup" }));
    expect((screen.getByRole("button", { name: "Review backup" }) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByRole("heading", { name: "Available backups" });
    expect(screen.queryByLabelText("Prepared restore UUID")).toBeNull();
    expect(screen.queryByText(stage.id)).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Available backup" }));
    fireEvent.click(await screen.findByRole("option", { name: /Full instance archive/ }));
    await reviewSelectedBackup();
    await screen.findByText(/Administrator \(admin@example.com\)/);
    expect(screen.queryByText(/Exclusions:/)).toBeNull();
    expect(screen.getByRole("switch", { name: "Recover an existing administrator" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Start the server after restoring" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.queryByRole("switch", { name: /Allow interruption/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Replace the displayed destination" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(fake?.callsTo("desktop_restore_apply")).toEqual([
        { staged: stage.id, confirmed: true, force: false, start: true },
      ]),
    );
    const nextButton = await screen.findByRole("button", { name: "Next" });
    await waitFor(() => expect(nextButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(nextButton);
    await screen.findByText(/confirmed a successful boot/);
  });
  it("re-extracts an expired preparation and applies only the matching refreshed stage", async () => {
    let preparations = 0;
    fake = installFakeIpc({
      handlers: {
        desktop_backup_list: () => ({ backups: [] }),
        "plugin:dialog|open": () => "/tmp/backup.subshell",
        desktop_restore_inspect: () => ({ ...stage, prepared: false }),
        desktop_restore_prepare: () => ({
          ...stage,
          id: `stage-${++preparations}`,
          expiresAt: Date.now() + (preparations === 1 ? -1 : 600000),
        }),
        desktop_restore_apply: () => ({ status: "completed", started: true, destination: stage.destination }),
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    await reviewSelectedBackup();
    await screen.findByRole("switch", { name: "Replace the displayed destination" });
    fireEvent.click(screen.getByRole("switch", { name: "Replace the displayed destination" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const nextButton = await screen.findByRole("button", { name: "Next" });
    await waitFor(() => expect(nextButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(nextButton);
    await screen.findByText(/confirmed a successful boot/);
    expect(fake.callsTo("desktop_restore_prepare")).toHaveLength(2);
    expect(fake.callsTo("desktop_restore_apply")[0]?.staged).toBe("stage-2");
  });
  it("returns to backup selection using the footer Back button", async () => {
    fake = installFakeIpc({
      handlers: {
        desktop_backup_list: () => ({ backups: [] }),
        "plugin:dialog|open": () => "/tmp/backup.subshell",
        desktop_restore_inspect: () => ({ ...stage, prepared: false }),
        desktop_restore_prepare: () => stage,
        desktop_restore_discard: () => null,
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" rail={<nav>Navigation</nav>} />);
    await reviewSelectedBackup();
    await screen.findByRole("switch", { name: "Replace the displayed destination" });
    const back = await screen.findByRole("button", { name: "Back" });
    expect(screen.queryByRole("button", { name: "Discard prepared restore" })).toBeNull();
    fireEvent.click(back);
    await screen.findByRole("button", { name: "Review backup" });
    expect(screen.queryByRole("heading", { name: "Backup details" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });
  it("asks for interruption only when restore reports incompatible sessions, and cancellation leaves them untouched", async () => {
    let finishRestore!: () => void;
    const restoring = new Promise<void>((resolve) => {
      finishRestore = resolve;
    });
    fake = installFakeIpc({
      handlers: {
        desktop_probe: () =>
          makeProbe({
            status: {
              settings: {
                APP_BASE_URL: { value: "https://restored.example" },
                HOST: { value: "127.0.0.1" },
                SERVER_PORT: { value: "4567" },
              },
            },
          }),
        desktop_backup_list: () => ({ backups: [] }),
        "plugin:dialog|open": () => "/tmp/backup.subshell",
        desktop_restore_inspect: () => ({ ...stage, prepared: false }),
        desktop_restore_prepare: () => stage,
        desktop_restore_apply: async ({ force }) => {
          if (!force)
            throw new Error(
              "RESTORE_SESSION_CONFIRMATION_REQUIRED: 2 active sessions cannot be preserved with this backup. Continuing closes affected local sessions. Affected remote sessions may disconnect or end when their node reconnects. Other compatible sessions will be preserved. Cancel leaves your server unchanged.",
            );
          await restoring;
          return { status: "completed", started: true, destination: stage.destination };
        },
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    await reviewSelectedBackup();
    await screen.findByRole("switch", { name: "Replace the displayed destination" });
    fireEvent.click(await screen.findByRole("switch", { name: "Replace the displayed destination" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await screen.findByRole("dialog", { name: "Some sessions cannot survive this restore" });
    expect(screen.getByText("2 active sessions").className).toContain("text-warning");
    expect(screen.getByRole("dialog").querySelectorAll("li")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fake.callsTo("desktop_restore_apply")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue restore" }));
    await screen.findByText("Restoring Your Server");
    expect(screen.queryByRole("button", { name: "Review backup" })).toBeNull();
    expect(screen.getByText("Restoring…").hasAttribute("disabled")).toBe(true);
    finishRestore();
    const next = await screen.findByRole("button", { name: "Next" });
    await waitFor(() => expect(next.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText("Restore Complete")).toBeNull();
    expect(screen.getByText("Restoring Your Server")).toBeTruthy();
    fireEvent.click(next);
    await screen.findByText("Restore Complete");
    await screen.findByText(/confirmed a successful boot/);
    expect(screen.queryByRole("button", { name: "Review backup" })).toBeNull();
    expect(screen.getByText("Control plane URL")).toBeTruthy();
    expect(screen.getByText("https://restored.example")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Control plane URL" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Database" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open control plane" }));
    await waitFor(() => expect(fake?.callsTo("desktop_open_main")).toHaveLength(1));
    expect(screen.getByText("4567")).toBeTruthy();
    expect(screen.getByText(stage.destination.databasePath)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(fake.callsTo("desktop_restore_apply").map((call) => call.force)).toEqual([false, false, true]);
  });
  it("reports inspection failure before any preparation or restore operation", async () => {
    fake = installFakeIpc({
      handlers: {
        desktop_backup_list: () => ({ backups: [] }),
        "plugin:dialog|open": () => "/tmp/bad-archive.subshell",
        desktop_restore_inspect: () => {
          throw new Error("Checksum validation failed");
        },
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    fireEvent.click(screen.getByRole("button", { name: "Choose backup file…" }));
    await screen.findByText("Checksum validation failed");
    expect(screen.getByRole("button", { name: "Review backup" }).hasAttribute("disabled")).toBe(true);
    expect(fake.callsTo("desktop_restore_prepare")).toHaveLength(0);
    expect(fake.callsTo("desktop_restore_apply")).toHaveLength(0);
  });
  it("labels legacy snapshots and keeps administrator recovery off", async () => {
    fake = installFakeIpc({
      handlers: {
        desktop_backup_list: () => ({
          backups: [
            {
              path: "/tmp/legacy.db",
              name: "subshell-v1.7.0-20260101-000000.db",
              bytes: 1024,
              createdAt: "2026-01-01T00:00:00Z",
              serverVersion: "1.7.0",
              legacyDatabaseOnly: true,
              encrypted: false,
            },
          ],
        }),
        "plugin:dialog|open": () => "/tmp/legacy.db",
        desktop_restore_inspect: () => ({ ...stage, id: undefined, prepared: false, legacyDatabaseOnly: true }),
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    fireEvent.click(await screen.findByRole("radio", { name: "Use a saved backup" }));
    fireEvent.click(await screen.findByRole("combobox", { name: "Available backup" }));
    fireEvent.click(await screen.findByRole("option", { name: /Database-only snapshot/ }));
    await reviewSelectedBackup();
    expect(fake.callsTo("desktop_restore_inspect")[0]).toMatchObject({ archive: "/tmp/legacy.db", staged: "" });
    await screen.findByRole("heading", { name: "Backup details" });
    expect(screen.getByRole("radiogroup", { name: "Restore mode" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Same-machine recovery" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Move to a new machine" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("switch", { name: "Recover an existing administrator" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });
  it("drops incompatible hidden migration choices when switching to a legacy snapshot", async () => {
    let inspection = 0;
    fake = installFakeIpc({
      handlers: {
        desktop_backup_list: () => ({ backups: [] }),
        "plugin:dialog|open": () => "/tmp/backup.db",
        desktop_restore_inspect: () => ({
          ...stage,
          id: undefined,
          prepared: false,
          legacyDatabaseOnly: inspection++ > 0,
        }),
        desktop_restore_prepare: () => ({ ...stage, legacyDatabaseOnly: true, choices: { mode: "same-machine" } }),
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    await reviewSelectedBackup();
    await screen.findByRole("radio", { name: "Move to a new machine" });
    expect(screen.getByRole("radio", { name: "Same-machine recovery" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Move to a new machine" }));
    expect(screen.getByRole("radio", { name: "Move to a new machine" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByLabelText("Public base URL (optional)"), {
      target: { value: "https://previous.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await reviewSelectedBackup();
    await screen.findByRole("heading", { name: "Backup details" });
    fireEvent.click(screen.getByRole("switch", { name: "Replace the displayed destination" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(fake?.callsTo("desktop_restore_prepare")).toHaveLength(1));
    expect(fake.callsTo("desktop_restore_prepare")[0]?.options).toMatchObject({
      mode: "same-machine",
      baseUrl: "",
      databasePath: "",
      dataDir: "",
      configDir: "",
    });
  });
});
