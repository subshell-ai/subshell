import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserRowActions } from "@/components/users/user-row-actions";

/**
 * The per-row admin controls. Most of what this component must get right is
 * about what it does NOT offer:
 *
 * - nothing at all on your own row — neither the role select nor the reset nor
 *   the disable switch, because every one of them is a way to lock yourself
 *   out of the instance you are administering;
 * - no client-side guess at the last-admin rule — the controls are always
 *   live and the server's 409 is what explains a refusal, so the two can never
 *   disagree about when it applies.
 */
interface Patched {
  url: string;
  body: unknown;
}

/** Captures every PATCH and answers it with `response()`; anything else is an empty 200. */
function mockFetch(response: () => Response): { patches: Patched[]; restore: () => void } {
  const patches: Patched[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "PATCH") {
      patches.push({ url: url.pathname, body: JSON.parse(String(init.body)) });
      return Promise.resolve(response());
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return {
    patches,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const ok = (body: unknown = {}) => new Response(JSON.stringify(body));

function renderRow(
  over: { id?: string; email?: string; role?: string | null; disabled?: boolean } = {},
  viewerId: string | null = "me",
  onChanged: () => void = () => {},
) {
  render(
    <UserRowActions
      user={{
        id: over.id ?? "u1",
        email: over.email ?? "someone@example.com",
        role: over.role ?? "user",
        disabled: over.disabled,
      }}
      viewerId={viewerId}
      onChanged={onChanged}
    />,
  );
}

const roleTrigger = () => screen.getByRole("combobox", { name: /^Role for/ });
const disableButton = () => screen.getByRole("button", { name: "Disable" });

afterEach(cleanup);

describe("UserRowActions", () => {
  it("offers a role control naming the user it belongs to", () => {
    renderRow({ email: "dana@example.com" });
    expect(screen.getByRole("combobox", { name: "Role for dana@example.com" })).toBeDefined();
  });

  it("spells the selected role on the trigger the way the menu spells it", () => {
    // Base UI's `Value` renders the RAW value unless the root is handed an
    // items map, so without one the trigger read "admin" under a menu whose
    // items read "Admin".
    renderRow({ role: "admin" });
    expect(roleTrigger().textContent).toContain("Admin");
  });

  it("offers a password reset and a disable for someone else", () => {
    renderRow({ id: "other" }, "me");
    expect(screen.getByRole("button", { name: /reset password/i })).toBeDefined();
    expect(disableButton()).toBeDefined();
  });

  it("offers NOTHING but a label on your own row", () => {
    // An admin who demotes or disables themselves cannot undo it without
    // another admin, and there may not be one.
    renderRow({ id: "me", role: "admin" }, "me");
    expect(screen.queryByRole("combobox", { name: /^Role for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /reset password/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Disable|Enable)$/ })).toBeNull();
    expect(screen.getByText("Your account")).toBeDefined();
  });

  it("shows the controls when the viewer's id is unknown", () => {
    // `viewerId` null means the session lookup has not resolved. Hiding the
    // controls would be a worse failure than showing them — the server refuses
    // every self-directed act regardless, so the fallback is safe either way.
    renderRow({ id: "u1" }, null);
    expect(screen.getByRole("button", { name: /reset password/i })).toBeDefined();
    expect(disableButton()).toBeDefined();
  });

  it("renders for a user with no role row at all", () => {
    // `listWithRoles` returns role: null for a user with no user_meta row, so
    // that state is reachable and must not blank the control or throw.
    renderRow({ role: null });
    expect(roleTrigger().textContent).toContain("User");
    expect(screen.getByRole("button", { name: /reset password/i })).toBeDefined();
  });

  it("asks before disabling, and says what the mechanism cannot", async () => {
    const { patches, restore } = mockFetch(() => ok({ sessionsRevoked: 2 }));
    try {
      renderRow({ id: "u9", email: "dana@example.com" });
      fireEvent.click(disableButton());
      const dialog = await screen.findByRole("dialog");
      expect(dialog.textContent).toContain("dana@example.com");
      // The two facts a disabled account does not announce for itself.
      expect(dialog.textContent).toMatch(/every device/i);
      expect(dialog.textContent).toMatch(/not notified/i);
      // Nothing has been sent yet — opening the dialog is not the act.
      expect(patches).toEqual([]);
    } finally {
      restore();
    }
  });

  it("disables on confirmation and reports the sessions it cut", async () => {
    const { patches, restore } = mockFetch(() =>
      ok({ id: "u9", email: "d@e.com", disabled: true, sessionsRevoked: 2 }),
    );
    let changed = 0;
    try {
      renderRow({ id: "u9" }, "me", () => changed++);
      fireEvent.click(disableButton());
      fireEvent.click(await screen.findByRole("button", { name: "Disable and sign out" }));
      await waitFor(() => expect(patches.length).toBe(1));
      expect(patches[0]?.url).toBe("/api/users/u9/disabled");
      expect(patches[0]?.body).toEqual({ disabled: true });
      await waitFor(() => expect(screen.getByText(/Signed out of 2 sessions\./)).toBeDefined());
      expect(changed).toBe(1);
    } finally {
      restore();
    }
  });

  it("says so when a disabled user had no sessions at all", async () => {
    const { restore } = mockFetch(() => ok({ sessionsRevoked: 0 }));
    try {
      renderRow({ id: "u9" });
      fireEvent.click(disableButton());
      fireEvent.click(await screen.findByRole("button", { name: "Disable and sign out" }));
      await waitFor(() => expect(screen.getByText(/no active sessions/i)).toBeDefined());
    } finally {
      restore();
    }
  });

  it("shows the last-admin refusal verbatim and leaves the row enabled", async () => {
    const { restore } = mockFetch(
      () => new Response(JSON.stringify({ message: "Cannot disable the last admin" }), { status: 409 }),
    );
    let changed = 0;
    try {
      renderRow({ id: "u9", role: "admin" }, "me", () => changed++);
      fireEvent.click(disableButton());
      fireEvent.click(await screen.findByRole("button", { name: "Disable and sign out" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Cannot disable the last admin"));
      // The roster is not refetched, and the dialog has not reported success.
      expect(changed).toBe(0);
      expect(screen.queryByText(/Signed out of/)).toBeNull();
    } finally {
      restore();
    }
  });

  it("enables without a confirmation — it only widens access", async () => {
    const { patches, restore } = mockFetch(() => ok({ disabled: false, sessionsRevoked: 0 }));
    let changed = 0;
    try {
      renderRow({ id: "u9", disabled: true }, "me", () => changed++);
      expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Enable" }));
      await waitFor(() => expect(patches.length).toBe(1));
      expect(patches[0]?.url).toBe("/api/users/u9/disabled");
      expect(patches[0]?.body).toEqual({ disabled: false });
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(changed).toBe(1));
    } finally {
      restore();
    }
  });
});
