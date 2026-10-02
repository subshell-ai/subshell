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

describe("native backup and restore", () => {
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
    expect(screen.getByText(/plugin-owned secrets/).textContent).toContain("external agent credentials");
    expect(screen.getByText(/plugin-owned secrets/).textContent).toContain("user uploads");
  });
  it("preserves prepared choices and separates replacement from pane consent, start defaults on", async () => {
    fake = installFakeIpc({
      handlers: {
        desktop_restore_stages: () => ({ stages: [stage] }),
        desktop_restore_inspect: () => stage,
        desktop_restore_apply: () => ({ status: "completed", started: true, destination: stage.destination }),
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    await screen.findByLabelText("Prepared local restores");
    fireEvent.change(screen.getByLabelText("Prepared local restores"), { target: { value: stage.id } });
    await screen.findByText(/Administrator recovery: admin@example.com/);
    expect(screen.queryByLabelText("Recover an existing administrator")).toBeNull();
    expect(screen.getByRole("switch", { name: "Start the server after restoring" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("switch", { name: /Allow interruption/ }).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Replace the displayed destination" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(fake?.callsTo("desktop_restore_apply")).toEqual([
        { staged: stage.id, confirmed: true, force: false, start: true },
      ]),
    );
    await screen.findByText(/confirmed a successful boot/);
  });
  it("reports inspection failure before any preparation or restore operation", async () => {
    fake = installFakeIpc({
      handlers: {
        desktop_restore_stages: () => ({ stages: [] }),
        "plugin:dialog|open": () => "/tmp/bad-archive.subshell",
        desktop_restore_inspect: () => {
          throw new Error("Checksum validation failed");
        },
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    fireEvent.click(screen.getByRole("button", { name: "Open and inspect archive…" }));
    await screen.findByText("Checksum validation failed");
    expect(fake.callsTo("desktop_restore_prepare")).toHaveLength(0);
    expect(fake.callsTo("desktop_restore_apply")).toHaveLength(0);
  });
  it("labels legacy snapshots and keeps administrator recovery off", async () => {
    fake = installFakeIpc({
      handlers: {
        desktop_restore_stages: () => ({ stages: [] }),
        "plugin:dialog|open": () => "/tmp/legacy.db",
        desktop_restore_inspect: () => ({ ...stage, id: undefined, prepared: false, legacyDatabaseOnly: true }),
      },
    });
    render(<BackupRestoreScreen {...props} kind="restore" />);
    fireEvent.click(screen.getByRole("button", { name: "Open and inspect archive…" }));
    await screen.findByText(/Database-only snapshot:/);
    expect(screen.getByRole("switch", { name: "Recover an existing administrator" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });
  it("drops incompatible hidden migration choices when switching to a legacy snapshot", async () => {
    let inspection = 0;
    fake = installFakeIpc({
      handlers: {
        desktop_restore_stages: () => ({ stages: [] }),
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
    fireEvent.click(screen.getByRole("button", { name: "Open and inspect archive…" }));
    await screen.findByLabelText("Move to a new machine");
    fireEvent.click(screen.getByLabelText("Move to a new machine"));
    fireEvent.change(screen.getByLabelText("Public base URL (optional)"), {
      target: { value: "https://previous.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open and inspect archive…" }));
    await screen.findByText(/Database-only snapshot:/);
    fireEvent.click(screen.getByRole("button", { name: "Review replacement" }));
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
