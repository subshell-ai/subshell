import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChangePasswordCard } from "@/components/change-password-card";

/**
 * The gating sweep (spec 2026-09-29): Update is disabled until the one
 * schema is satisfied, and the disabled state never goes unexplained — the
 * requirement line stands under the new-password box from the first render
 * (the 2026-09-14 rule that made `lib/password` exist at all).
 */

afterEach(cleanup);

const updateButton = () => screen.getByRole("button", { name: "Update password" }) as HTMLButtonElement;
const currentField = () => screen.getByLabelText("Current password") as HTMLInputElement;
const nextField = () => screen.getByLabelText("New password") as HTMLInputElement;
const confirmField = () => screen.getByLabelText("Confirm new password") as HTMLInputElement;

describe("ChangePasswordCard gating", () => {
  it("is DISABLED on a pristine card, with the requirement line already explaining", () => {
    render(<ChangePasswordCard />);
    expect(updateButton().disabled).toBe(true);
    expect(screen.getByText("At least 8 characters")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a too-short new password keeps the gate shut and says so once touched", () => {
    render(<ChangePasswordCard />);
    fireEvent.change(currentField(), { target: { value: "old-one" } });
    fireEvent.change(nextField(), { target: { value: "abc" } });
    fireEvent.blur(nextField());
    expect(updateButton().disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("at least 8 characters");
    // Typing enough re-opens the gate (still mismatched, though: confirm).
    fireEvent.change(nextField(), { target: { value: "abcdefgh" } });
    expect(updateButton().disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull(); // confirm was never touched
  });

  it("matching the confirm field is what opens the gate", () => {
    render(<ChangePasswordCard />);
    fireEvent.change(currentField(), { target: { value: "old-one" } });
    fireEvent.change(nextField(), { target: { value: "abcdefgh" } });
    fireEvent.change(confirmField(), { target: { value: "abcdefg" } });
    fireEvent.blur(confirmField());
    expect(updateButton().disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("New passwords do not match");
    fireEvent.change(confirmField(), { target: { value: "abcdefgh" } });
    expect(updateButton().disabled).toBe(false);
  });
});
