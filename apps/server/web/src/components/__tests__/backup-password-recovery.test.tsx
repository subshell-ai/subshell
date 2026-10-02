import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackupPasswordRecovery } from "@/components/backup-password-recovery";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("temporary restore password form", () => {
  it("explains recovery and refuses mismatched passwords before a request", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(args);
      return Response.json({});
    }) as unknown as typeof fetch;
    render(<BackupPasswordRecovery />);
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "temporary-password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password-one" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-password-two" } });
    const form = screen.getByRole("button", { name: "Change password and sign in" }).closest("form");
    if (!form) throw new Error("Recovery form missing");
    fireEvent.focus(screen.getByLabelText("Confirm new password"));
    expect(screen.queryByText("The new passwords do not match.")).toBeNull();
    fireEvent.blur(screen.getByLabelText("Confirm new password"));
    await waitFor(() => expect(screen.getByText("The new passwords do not match.")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Change password and sign in" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(calls).toHaveLength(0);
  });

  it("keeps pristine, short, unchanged, and oversized passwords disabled, including implicit submission", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(args);
      return Response.json({});
    }) as unknown as typeof fetch;
    render(<BackupPasswordRecovery />);
    const submit = screen.getByRole("button", { name: "Change password and sign in" }) as HTMLButtonElement;
    const form = submit.closest("form");
    if (!form) throw new Error("Recovery form missing");
    expect(submit.disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      fireEvent.submit(form);
    });
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "temporary-password" } });
    for (const invalid of ["short", "temporary-password", "p".repeat(4097)]) {
      for (const label of ["New password", "Confirm new password"])
        fireEvent.change(screen.getByLabelText(label), { target: { value: invalid } });
      expect(submit.disabled).toBe(true);
      await act(async () => {
        fireEvent.submit(form);
      });
    }
    for (const label of ["New password", "Confirm new password"])
      fireEvent.change(screen.getByLabelText(label), { target: { value: "p".repeat(4096) } });
    expect(submit.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "" } });
    expect(submit.disabled).toBe(true);
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(calls).toHaveLength(0));
  });

  it("shows a failed verified change and allows retry", async () => {
    globalThis.fetch = (async () =>
      Response.json({ message: "The current password is incorrect." }, { status: 400 })) as unknown as typeof fetch;
    render(<BackupPasswordRecovery />);
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "wrong-password" } });
    for (const label of ["New password", "Confirm new password"])
      fireEvent.change(screen.getByLabelText(label), { target: { value: "new-password-one" } });
    const form = screen.getByRole("button", { name: "Change password and sign in" }).closest("form");
    if (!form) throw new Error("Recovery form missing");
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(screen.getByText(/The current password is incorrect/)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Change password and sign in" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
