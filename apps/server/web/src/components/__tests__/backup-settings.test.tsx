import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreateBackupCard } from "@/components/backups/create-backup-card";
import { RestoreBackupCard } from "@/components/backups/restore-backup-card";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
function mount(element: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      {element}
    </QueryClientProvider>,
  );
}
const destination = {
  databasePath: "/tmp/restore/subshell.db",
  dataDir: "/tmp/restore",
  configPath: "/tmp/restore/config.env",
};
const inspection = {
  id: "restore-stage",
  expiresAt: Date.now() + 600000,
  legacyDatabaseOnly: false,
  destination,
  choices: {
    mode: "same-machine",
    configOverrides: { host: "127.0.0.1", port: "3080", baseUrl: "http://localhost:3080", trustedOrigins: "" },
  },
  admins: [{ id: "admin", email: "admin@example.test", name: "Admin" }],
  manifest: { serverVersion: "1.0", completedAt: "2026-10-01T00:00:00Z", entries: [], exclusions: ["binary caches"] },
};
type Request = { path: string; method: string; body: BodyInit | null | undefined };
function mockApi(handler?: (request: Request) => Response | Promise<Response> | undefined) {
  const requests: Request[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const request = { path: String(url), method: init?.method ?? "GET", body: init?.body };
    requests.push(request);
    const handled = handler?.(request);
    if (handled) return handled;
    if (request.path.endsWith("/saved")) return Response.json({ backups: [] });
    if (request.method === "DELETE") return Response.json({ deleted: true });
    if (/\/inspect(?:-saved)?$/.test(request.path)) return Response.json(inspection);
    if (request.path.endsWith("/create")) return Response.json({ id: "backup-job" });
    if (request.path.includes("/jobs/"))
      return Response.json({ id: "backup-job", status: "ready", filename: "instance.subshell", bytes: 123456 });
    return Response.json({
      id: inspection.id,
      expiresAt: Date.now() + 600000,
      command: "subshell-server restore --staged restore-stage",
    });
  }) as unknown as typeof fetch;
  return requests;
}
const posts = (requests: Request[]) => requests.filter((request) => request.method === "POST");
async function selectFile() {
  fireEvent.change(screen.getByLabelText("Backup file"), {
    target: { files: [new File(["archive"], "instance.subshell")] },
  });
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Configure backup" }) as HTMLButtonElement).disabled).toBe(false),
  );
}
async function configureFile() {
  await selectFile();
  fireEvent.click(screen.getByRole("button", { name: "Configure backup" }));
  await screen.findByText("Configure Restore");
}
function reviewConfiguration() {
  fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
}
async function confirmReview() {
  const confirm = await screen.findByRole("checkbox", {
    name: "I confirm the destination and restore options shown above",
  });
  expect((screen.getByRole("button", { name: "Prepare restore" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(confirm);
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Prepare restore" }) as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Prepare restore" }));
}

describe("Settings backup workflows", () => {
  it("holds a finished backup on progress until Next, then offers the download and facts", async () => {
    const requests = mockApi();
    mount(<CreateBackupCard />);
    expect(screen.queryByLabelText("Archive password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    await screen.findByText("Backup finished");
    expect(screen.queryByText("Backup Complete")).toBeNull();
    expect(screen.queryByRole("link", { name: "Download backup" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Your backup is ready")).toBeTruthy();
    expect(screen.getByText("123,456 bytes")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download backup" }).getAttribute("href")).toBe(
      "/api/admin/backups/download/backup-job",
    );
    expect(screen.queryByRole("button", { name: /Copy.*(?:size|encryption)/i })).toBeNull();
    expect(posts(requests)[0]?.body).toBe("{}");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByText("Back Up Your Server");
  });

  it("shows progress while creation is pending and leaves Next disabled", async () => {
    let finish: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    mockApi((request) => (request.path.endsWith("/create") ? pending : undefined));
    const activity: boolean[] = [];
    mount(<CreateBackupCard onBusy={(value) => activity.push(value)} />);
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    await screen.findByText("Creating your backup");
    expect((screen.getByRole("button", { name: "Backing up…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(activity).toContain(true);
    finish?.(Response.json({ id: "backup-job" }));
    await screen.findByText("Backup finished");
    expect(activity.at(-1)).toBe(false);
  });

  it("gates encryption on shared validation and keeps gold errors beside blurred fields", async () => {
    const requests = mockApi();
    mount(<CreateBackupCard />);
    fireEvent.click(screen.getByRole("switch", { name: "Encrypt the archive with a password" }));
    const submit = screen.getByRole("button", { name: "Create backup" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const password = screen.getByLabelText("Archive password");
    const confirm = screen.getByLabelText("Confirm archive password");
    for (const input of [password, confirm]) fireEvent.change(input, { target: { value: "short" } });
    fireEvent.blur(password);
    expect(screen.getByRole("alert").textContent).toContain("at least 8");
    expect(screen.getByRole("alert").className).toContain("text-warning");
    fireEvent.focus(password);
    fireEvent.change(password, { target: { value: "unique archive password" } });
    fireEvent.change(confirm, { target: { value: "different" } });
    fireEvent.blur(confirm);
    expect(screen.getByText("Passwords do not match.")).toBeTruthy();
    await act(async () => {
      fireEvent.submit(document.getElementById("create-backup-form") as HTMLFormElement);
    });
    expect(posts(requests)).toHaveLength(0);
    for (const input of [password, confirm]) fireEvent.change(input, { target: { value: "unique archive password" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await screen.findByText("Backup finished");
    expect(screen.queryByText("Passwords do not match.")).toBeNull();
    expect(JSON.parse(posts(requests)[0]?.body as string).password).toBe("unique archive password");
  });

  it("reports backup failure on the progress pane and returns to configuration", async () => {
    mockApi((request) =>
      request.path.endsWith("/create") ? Response.json({ message: "Capture failed" }, { status: 409 }) : undefined,
    );
    mount(<CreateBackupCard />);
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    await screen.findByText(/Capture failed/);
    expect(screen.queryByText("Your backup is ready")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText("Back Up Your Server");
  });

  it("uses a separate chooser, validates automatically, and stays on selection until Configure", async () => {
    const requests = mockApi();
    mount(<RestoreBackupCard />);
    expect((screen.getByRole("button", { name: "Configure backup" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Archive password")).toBeNull();
    const chooser = screen.getByRole("button", { name: "Choose backup file…" });
    const before = chooser.outerHTML;
    fireEvent.click(chooser);
    expect(chooser.outerHTML).toBe(before);
    await selectFile();
    expect(posts(requests)).toHaveLength(1);
    expect(screen.getByText("Restore Your Server")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Validate backup" })).toBeNull();
    expect(screen.queryByLabelText("Archive password")).toBeNull();
  });

  it("asks for passwords only for encrypted archives and keeps failures beside the password", async () => {
    let finish: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    mockApi((request) => {
      if (!request.path.endsWith("/inspect")) return;
      const password = (request.body as FormData).get("password");
      if (!password) return Response.json({ message: "this backup requires a password" }, { status: 400 });
      if (password === "incorrect")
        return Response.json(
          { message: "backup authentication failed: wrong password or damaged archive" },
          { status: 400 },
        );
      return pending;
    });
    mount(<RestoreBackupCard />);
    fireEvent.change(screen.getByLabelText("Backup file"), {
      target: { files: [new File(["archive"], "encrypted.subshell")] },
    });
    const password = await screen.findByLabelText("Archive password");
    await screen.findByText(/This backup is encrypted/);
    expect((screen.getByRole("button", { name: "Configure backup" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(password, { target: { value: "incorrect" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate backup" }));
    await screen.findByText(/The password is incorrect/);
    expect(screen.queryByText(/password-file/)).toBeNull();
    fireEvent.change(password, { target: { value: "correct-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate backup" }));
    await screen.findByText("Validating backup…");
    expect(screen.getByRole("button", { name: "Choose backup file…" }).querySelector("svg")).toBeNull();
    expect(screen.getByRole("button", { name: "Validate backup" }).querySelector("svg")).not.toBeNull();
    finish?.(Response.json(inspection));
    await screen.findByText("Backup validated. Select Configure backup to continue.");
  });

  it("shows an empty saved-backup state and validates saved selection without a manual step", async () => {
    const requests = mockApi((request) =>
      request.path.endsWith("/saved")
        ? Response.json({
            backups: [
              {
                path: "/tmp/saved.subshell",
                name: "saved.subshell",
                createdAt: "2026-10-01T00:00:00Z",
                bytes: 100,
                encrypted: false,
                legacyDatabaseOnly: false,
              },
            ],
          })
        : undefined,
    );
    mount(<RestoreBackupCard />);
    fireEvent.click(screen.getByRole("radio", { name: "Use a saved backup" }));
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Available backups" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Available backups" }));
    fireEvent.click(await screen.findByRole("option", { name: /saved.subshell/ }));
    await screen.findByText("Backup validated. Select Configure backup to continue.");
    expect(posts(requests)[0]?.path).toBe("/api/admin/backups/inspect-saved");
    expect(JSON.parse(posts(requests)[0]?.body as string)).toEqual({ path: "/tmp/saved.subshell" });
    expect(screen.queryByRole("button", { name: "Validate backup" })).toBeNull();
  });

  it("explains when no saved backups exist", async () => {
    mockApi();
    mount(<RestoreBackupCard />);
    fireEvent.click(screen.getByRole("radio", { name: "Use a saved backup" }));
    await screen.findByText("No saved backups are available. Open a backup file instead.");
    expect((screen.getByRole("button", { name: "Configure backup" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("validates configuration on blur, retains recovery fields through review, and prepares only after confirmation", async () => {
    let finish: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const requests = mockApi((request) =>
      request.method === "POST" && request.path.includes("/staged/") ? pending : undefined,
    );
    mount(<RestoreBackupCard />);
    await configureFile();
    const port = screen.getByLabelText("Port (optional)");
    fireEvent.change(port, { target: { value: "70000" } });
    expect((screen.getByRole("button", { name: "Review backup" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(port);
    expect(screen.getByRole("alert").textContent).toBe("Enter a port from 1 to 65535.");
    fireEvent.focus(port);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(port, { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("switch", { name: "Recover an existing administrator" }));
    expect((screen.getByRole("button", { name: "Review backup" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("combobox", { name: "Administrator" }));
    fireEvent.click(await screen.findByRole("option", { name: "Admin · admin@example.test" }));
    for (const label of ["Temporary password (at least eight characters)", "Confirm temporary password"]) {
      const input = screen.getByLabelText(label);
      fireEvent.change(input, { target: { value: "temporary-password" } });
      fireEvent.blur(input);
    }
    fireEvent.click(screen.getByRole("switch", { name: "Start the server after restoring" }));
    reviewConfiguration();
    await screen.findByText("Review Restore");
    expect(posts(requests)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("Confirm temporary password") as HTMLInputElement).value).toBe("temporary-password");
    expect((screen.getByLabelText("Port (optional)") as HTMLInputElement).value).toBe("4000");
    reviewConfiguration();
    await confirmReview();
    await screen.findByText("Preparing your restore");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText("Confirm temporary password")).toBeNull();
    expect((screen.getByRole("button", { name: "Preparing…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(JSON.parse(posts(requests)[1]?.body as string)).toEqual({
      mode: "same-machine",
      start: false,
      destination,
      configOverrides: { baseUrl: "http://localhost:3080", host: "127.0.0.1", port: "4000", trustedOrigins: "" },
      recoveryUserId: "admin",
      temporaryPassword: "temporary-password",
    });
    finish?.(
      Response.json({
        id: inspection.id,
        expiresAt: Date.now() + 600000,
        command: "subshell-server restore --staged restore-stage --no-start",
      }),
    );
    await screen.findByText("Your restore is ready to apply");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByText("Your restore is ready to apply")).toBeTruthy();
    expect(screen.getByText("subshell-server restore --staged restore-stage --no-start")).toBeTruthy();
    expect(screen.queryByText("Restore Complete")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByText("Restore Your Server");
    // Leaving the handoff must not delete the stage the copied command refers to.
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("revalidates expired extraction before preparation and stops for review if the source changed", async () => {
    let inspected = 0;
    const requests = mockApi((request) => {
      if (request.path.endsWith("/inspect"))
        return Response.json(
          inspected++ === 0
            ? { ...inspection, expiresAt: 0 }
            : { ...inspection, id: "new-stage", manifest: { ...inspection.manifest, serverVersion: "2.0" } },
        );
    });
    mount(<RestoreBackupCard />);
    await configureFile();
    reviewConfiguration();
    await confirmReview();
    await screen.findByText("The backup changed. Review it again before preparing the restore.");
    expect(posts(requests)).toHaveLength(2);
    expect(screen.getByText("2.0")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Prepare restore" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("rejects oversized files locally and never prepares an invalid archive", async () => {
    const requests = mockApi();
    mount(<RestoreBackupCard />);
    const file = new File(["archive"], "huge.subshell");
    Object.defineProperty(file, "size", { value: 129 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("Backup file"), { target: { files: [file] } });
    await screen.findByText("Use the CLI or desktop assistant for files larger than 128 MB.");
    expect(posts(requests)).toHaveLength(0);
  });
});
