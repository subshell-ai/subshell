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
describe("Settings backups", () => {
  it("creates without encryption by default and offers a browser download", async () => {
    const requests: { url: string; body?: string }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body as string | undefined });
      return Response.json(
        url.endsWith("/create")
          ? { id: "backup-job" }
          : { id: "backup-job", status: "ready", filename: "instance.tar.gz" },
      );
    }) as unknown as typeof fetch;
    mount(<CreateBackupCard />);
    expect(screen.queryByLabelText("Encryption password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download instance.tar.gz" }).getAttribute("href")).toBe(
        "/api/admin/backups/download/backup-job",
      ),
    );
    expect(requests[0]?.body).toBe("{}");
    expect(screen.getByText(/available once, for one hour/)).toBeTruthy();
  });
  it("gates optional encryption, explains mismatches on blur, and clears secrets after creation", async () => {
    const requests: { url: string; body?: string }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body as string | undefined });
      return Response.json(
        url.endsWith("/create")
          ? { id: "encrypted-job" }
          : { id: "encrypted-job", status: "ready", filename: "encrypted.subshell-backup" },
      );
    }) as unknown as typeof fetch;
    mount(<CreateBackupCard />);
    const submit = screen.getByRole("button", { name: "Create backup" }) as HTMLButtonElement;
    const form = submit.closest("form");
    if (!form) throw new Error("Create form missing");
    expect(submit.disabled).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: "Encrypt with a password" }));
    expect(submit.disabled).toBe(true);
    await act(async () => {
      fireEvent.submit(form);
    });
    const password = screen.getByLabelText("Encryption password");
    const confirm = screen.getByLabelText("Confirm password");
    for (const input of [password, confirm]) fireEvent.change(input, { target: { value: "short" } });
    fireEvent.blur(password);
    expect(screen.getByText("Use at least 8 characters for the archive password.")).toBeTruthy();
    expect(submit.disabled).toBe(true);
    fireEvent.focus(password);
    fireEvent.change(password, { target: { value: "secret" } });
    fireEvent.focus(confirm);
    fireEvent.change(confirm, { target: { value: "different" } });
    expect(screen.queryByText("Passwords do not match.")).toBeNull();
    fireEvent.blur(confirm);
    expect(screen.getByText("Passwords do not match.")).toBeTruthy();
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(requests).toHaveLength(0);
    for (const input of [password, confirm]) fireEvent.change(input, { target: { value: "p".repeat(4097) } });
    expect(submit.disabled).toBe(true);
    await act(async () => {
      fireEvent.submit(form);
    });
    for (const input of [password, confirm]) fireEvent.change(input, { target: { value: "p".repeat(4096) } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: "Encrypt with a password" }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: "Encrypt with a password" }));
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole("link", { name: "Download encrypted.subshell-backup" })).toBeTruthy());
    expect(JSON.parse(requests[0]?.body ?? "{}").password).toBe("p".repeat(4096));
    expect((screen.getByLabelText("Encryption password") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Confirm password") as HTMLInputElement).value).toBe("");
    expect(submit.disabled).toBe(true);
  });

  it("requires an archive and gates administrator recovery while preserving preparation choices", async () => {
    const requests: { url: string; body?: BodyInit | null }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body });
      return Response.json(
        url.endsWith("/inspect")
          ? {
              id: "restore-stage",
              expiresAt: Date.now() + 3600000,
              legacyDatabaseOnly: false,
              admins: [{ id: "admin", email: "admin@example.test", name: "Admin" }],
              manifest: {
                serverVersion: "1.0",
                completedAt: new Date().toISOString(),
                entries: [],
                exclusions: ["binary caches"],
              },
            }
          : {
              id: "restore-stage",
              expiresAt: Date.now() + 3600000,
              command: "subshell-server restore --staged restore-stage",
            },
      );
    }) as unknown as typeof fetch;
    mount(<RestoreBackupCard />);
    const inspect = screen.getByRole("button", { name: "Inspect backup" }) as HTMLButtonElement;
    expect(inspect.disabled).toBe(true);
    const inspectForm = inspect.closest("form");
    if (!inspectForm) throw new Error("Inspect form missing");
    await act(async () => {
      fireEvent.submit(inspectForm);
    });
    expect(requests).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Backup archive or legacy .db snapshot"), {
      target: { files: [new File(["archive"], "instance.tar.gz")] },
    });
    expect(inspect.disabled).toBe(false);
    await act(async () => {
      fireEvent.submit(inspectForm);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Prepare restore" })).toBeTruthy());
    expect(screen.queryByText("What this backup excludes")).toBeNull();
    expect(screen.queryByText("binary caches")).toBeNull();
    expect((requests[0]?.body as FormData | undefined)?.get("password")).toBeNull();
    const prepare = screen.getByRole("button", { name: "Prepare restore" }) as HTMLButtonElement;
    const prepareForm = prepare.closest("form");
    if (!prepareForm) throw new Error("Prepare form missing");
    expect(prepare.disabled).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: "Set a temporary password for an existing admin" }));
    expect(prepare.disabled).toBe(true);
    for (const label of ["Temporary password", "Confirm temporary password"])
      fireEvent.change(screen.getByLabelText(label), { target: { value: "temporary-password" } });
    expect(prepare.disabled).toBe(true);
    await act(async () => {
      fireEvent.submit(prepareForm);
    });
    expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("combobox", { name: "Administrator" }));
    fireEvent.click(await screen.findByRole("option", { name: "Admin (admin@example.test)" }));
    expect(prepare.disabled).toBe(false);
    for (const invalid of ["short", "p".repeat(4097)]) {
      for (const label of ["Temporary password", "Confirm temporary password"])
        fireEvent.change(screen.getByLabelText(label), { target: { value: invalid } });
      expect(prepare.disabled).toBe(true);
      await act(async () => {
        fireEvent.submit(prepareForm);
      });
    }
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "temporary-password" } });
    fireEvent.focus(screen.getByLabelText("Confirm temporary password"));
    fireEvent.change(screen.getByLabelText("Confirm temporary password"), { target: { value: "different-password" } });
    expect(screen.queryByText("Temporary passwords do not match.")).toBeNull();
    fireEvent.blur(screen.getByLabelText("Confirm temporary password"));
    expect(screen.getByText("Temporary passwords do not match.")).toBeTruthy();
    await act(async () => {
      fireEvent.submit(prepareForm);
    });
    expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("switch", { name: "Set a temporary password for an existing admin" }));
    expect(prepare.disabled).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: "Set a temporary password for an existing admin" }));
    fireEvent.change(screen.getByLabelText("Confirm temporary password"), { target: { value: "temporary-password" } });
    expect(prepare.disabled).toBe(false);
    fireEvent.click(prepare);
    await waitFor(() => expect(screen.getByText("subshell-server restore --staged restore-stage")).toBeTruthy());
    expect(JSON.parse(requests[1]?.body as string)).toEqual({
      mode: "same-machine",
      recoveryUserId: "admin",
      temporaryPassword: "temporary-password",
    });
  });

  it("labels a legacy snapshot and leaves administrator recovery off", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      bodies.push(init?.body);
      return Response.json(
        url.endsWith("/inspect")
          ? {
              id: "restore-stage",
              expiresAt: Date.now() + 3600000,
              legacyDatabaseOnly: true,
              admins: [{ id: "admin", email: "admin@example.test", name: "Admin" }],
              manifest: {
                serverVersion: "legacy",
                completedAt: new Date().toISOString(),
                entries: [{ path: "database.sqlite" }],
                exclusions: [],
              },
            }
          : {
              id: "restore-stage",
              expiresAt: Date.now() + 3600000,
              command: "subshell-server restore --staged restore-stage",
            },
      );
    }) as unknown as typeof fetch;
    mount(<RestoreBackupCard />);
    fireEvent.change(screen.getByLabelText("Backup archive or legacy .db snapshot"), {
      target: { files: [new File(["snapshot"], "old.db")] },
    });
    const form = screen.getByRole("button", { name: "Inspect backup" }).closest("form");
    if (!form) throw new Error("Inspect form missing");
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(screen.getByText(/Legacy database-only snapshot/)).toBeTruthy());
    expect(screen.queryByLabelText("Temporary password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Prepare restore" }));
    await waitFor(() => expect(screen.getByText("subshell-server restore --staged restore-stage")).toBeTruthy());
    const prepared = JSON.parse(bodies[1] as string);
    expect(prepared.mode).toBe("same-machine");
    expect(prepared.recoveryUserId).toBeUndefined();
    expect(prepared.temporaryPassword).toBeUndefined();
  });
});
