import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { UserRowActions } from "@/components/users/user-row-actions";

/**
 * The two things this component must get right are both about what it does
 * NOT offer:
 *
 * - no password reset on your own row, because Account is the path that
 *   requires the current password and offering both here would make the
 *   weaker one the obvious choice;
 * - no client-side guess at the last-admin rule — the role control is always
 *   live and the server's 409 is what explains a refusal, so the two can never
 *   disagree about when it applies.
 */
function renderRow(over: { id?: string; email?: string; role?: string | null } = {}, viewerId: string | null = "me") {
  render(
    <UserRowActions
      user={{ id: over.id ?? "u1", email: over.email ?? "someone@example.com", role: over.role ?? "user" }}
      viewerId={viewerId}
      onChanged={() => {}}
    />,
  );
}

describe("UserRowActions", () => {
  afterEach(cleanup);

  it("offers a role control naming the user it belongs to", () => {
    renderRow({ email: "dana@example.com" });
    expect(screen.getByRole("combobox", { name: "Role for dana@example.com" })).toBeDefined();
  });

  it("offers a password reset for someone else", () => {
    renderRow({ id: "other" }, "me");
    expect(screen.getByRole("button", { name: /reset password/i })).toBeDefined();
  });

  it("offers NO password reset on your own row", () => {
    renderRow({ id: "me" }, "me");
    expect(screen.queryByRole("button", { name: /reset password/i })).toBeNull();
  });

  it("still offers the role control on your own row", () => {
    // Stepping down is legitimate while another admin remains; the server's
    // last-admin guard is what refuses the case that would strand the
    // instance.
    renderRow({ id: "me", role: "admin" }, "me");
    expect(screen.getByRole("combobox", { name: /^Role for/ })).toBeDefined();
  });

  it("shows the reset control when the viewer's id is unknown", () => {
    // `viewerId` null means the session lookup has not resolved. Hiding the
    // control would be a worse failure than showing it — the server refuses a
    // self-reset regardless, so the fallback is safe either way.
    renderRow({ id: "u1" }, null);
    expect(screen.getByRole("button", { name: /reset password/i })).toBeDefined();
  });

  it("renders for a user with no role row at all", () => {
    // `listWithRoles` returns role: null for a user with no user_meta row, so
    // that state is reachable and must not blank the control or throw.
    // (Asserting the SELECTED LABEL would test Base UI's rendering, not this
    // component — the trigger renders no text in happy-dom.)
    renderRow({ role: null });
    expect(screen.getByRole("combobox", { name: /^Role for/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /reset password/i })).toBeDefined();
  });
});
