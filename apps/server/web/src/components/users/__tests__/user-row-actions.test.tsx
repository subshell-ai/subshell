import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserRowActions } from "@/components/users/user-row-actions";

/**
 * The per-row admin controls, as one `ActionsMenu`. Most of what this
 * component must get right is about what it does NOT offer:
 *
 * - nothing at all on your own row — not the role flip, not the reset, not the
 *   disable — because every one of them is a way to lock yourself out of the
 *   instance you are administering;
 * - no client-side guess at the last-admin rule — the menu is always live and
 *   the server's 409 is what explains a refusal, so the two can never
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
        // `undefined` defaults to the member role; an explicit `null` (no
        // `user_meta` row) must REACH the component as null.
        role: over.role === undefined ? "user" : over.role,
        disabled: over.disabled,
      }}
      viewerId={viewerId}
      onChanged={onChanged}
    />,
  );
}

const trigger = (email = "someone@example.com") => screen.getByRole("button", { name: `Actions for ${email}` });

/** Opens the kebab the way the Nodes-row tests do. */
async function openMenu(email?: string): Promise<void> {
  fireEvent.keyDown(trigger(email), { key: "ArrowDown" });
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBe(3));
}

async function pick(item: string, email?: string): Promise<void> {
  await openMenu(email);
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

afterEach(cleanup);

describe("UserRowActions", () => {
  it("offers one action menu naming the user it belongs to", () => {
    renderRow({ email: "dana@example.com" });
    expect(trigger("dana@example.com")).toBeDefined();
  });

  it("lists the flip named by the TARGET role, spelled like the badge's word", async () => {
    // "Promote to admin" / "Demote to user" — the word comes from
    // USER_ROLE_LABELS lowercased, so menu and Role column can never spell a
    // role differently. One flip item, not both; the enable/disable pair
    // swaps the same way.
    renderRow({ role: "user" });
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Promote to admin" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Demote to user" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Disable account" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Enable account" })).toBeNull();
  });

  it("offers the flip toward User on an admin row, and Enable on a disabled one", async () => {
    renderRow({ role: "admin", disabled: true });
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Demote to user" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Promote to admin" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Enable account" })).toBeDefined();
  });

  it("offers NOTHING but a label on your own row", () => {
    // An admin who demotes or disables themselves cannot undo it without
    // another admin, and there may not be one.
    renderRow({ id: "me", role: "admin" }, "me");
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
    expect(screen.getByText("Your account")).toBeDefined();
  });

  it("shows the menu when the viewer's id is unknown", () => {
    // `viewerId` null means the session lookup has not resolved. Hiding the
    // controls would be a worse failure than showing them — the server refuses
    // every self-directed act regardless, so the fallback is safe either way.
    renderRow({ id: "u1" }, null);
    expect(trigger()).toBeDefined();
  });

  it("renders for a user with no role row at all", async () => {
    // `listWithRoles` returns role: null for a user with no user_meta row, so
    // that state is reachable and must read as the member role it is.
    renderRow({ role: null });
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Promote to admin" })).toBeDefined();
  });

  it("promotes with one PATCH and no dialog", async () => {
    const { patches, restore } = mockFetch(() => ok());
    let changed = 0;
    try {
      renderRow({ id: "u9" }, "me", () => changed++);
      await pick("Promote to admin");
      await waitFor(() => expect(patches.length).toBe(1));
      expect(patches[0]?.url).toBe("/api/users/u9/role");
      expect(patches[0]?.body).toEqual({ role: "admin" });
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(changed).toBe(1));
    } finally {
      restore();
    }
  });

  it("shows the demotion refusal verbatim beside the menu", async () => {
    const { patches, restore } = mockFetch(
      () => new Response(JSON.stringify({ message: "Cannot demote the last admin" }), { status: 409 }),
    );
    let changed = 0;
    try {
      renderRow({ id: "u9", role: "admin" }, "me", () => changed++);
      await pick("Demote to user");
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Cannot demote the last admin"));
      // The body pins the demote direction specifically: a target-inversion
      // bug (always PATCHing admin) would show the refusal AND this assertion
      // would fail, where a length-only check would pass vacuously.
      expect(patches[0]?.url).toBe("/api/users/u9/role");
      expect(patches[0]?.body).toEqual({ role: "user" });
      expect(changed).toBe(0);
      expect(patches.length).toBe(1);
    } finally {
      restore();
    }
  });

  it("retires the refusal after its window, so a stale error cannot outlive the state it described", async () => {
    const { restore } = mockFetch(
      () => new Response(JSON.stringify({ message: "Cannot demote the last admin" }), { status: 409 }),
    );
    // Capture the component's own 8 s timer and fire it by hand; every other
    // setTimeout (waitFor's polling included) delegates to the real one.
    const real = globalThis.setTimeout;
    let retire: (() => void) | undefined;
    let capturedDelay = 0;
    globalThis.setTimeout = ((cb: () => void, delay?: number, ...rest: unknown[]) => {
      if (delay === 8000) {
        capturedDelay = delay;
        retire = cb;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return real(cb, delay, ...rest);
    }) as typeof setTimeout;
    try {
      renderRow({ id: "u9", role: "admin" }, "me");
      await pick("Demote to user");
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Cannot demote the last admin"));
      expect(capturedDelay).toBe(8000);
      act(() => retire?.());
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    } finally {
      globalThis.setTimeout = real;
      restore();
    }
  });

  it("shows a reset refusal inside the dialog, not behind its scrim", async () => {
    const { restore } = mockFetch(
      () => new Response(JSON.stringify({ message: "Cannot reset this account" }), { status: 403 }),
    );
    try {
      renderRow({ id: "u9" });
      await pick("Reset password");
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(screen.getByLabelText("New password"), { target: { value: "correct-horse-battery" } });
      fireEvent.click(screen.getByRole("button", { name: "Reset and sign out" }));
      await waitFor(() => expect(dialog.textContent).toContain("Cannot reset this account"));
      // ONE alert: presence in the dialog alone would also pass if the row
      // span's `!resetOpen` gate regressed and the refusal rendered twice.
      expect(screen.getAllByRole("alert")).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("does not smuggle a live role refusal into the disable confirmation", async () => {
    const { restore } = mockFetch(
      () => new Response(JSON.stringify({ message: "Cannot demote the last admin" }), { status: 409 }),
    );
    try {
      renderRow({ id: "u9", role: "admin" }, "me");
      await pick("Demote to user");
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Cannot demote the last admin"));
      // Still inside the 8 s window; opening the disable dialog must not
      // re-home that refusal under the new act's name.
      await pick("Disable account");
      const dialog = await screen.findByRole("dialog");
      expect(dialog.textContent).not.toContain("Cannot demote the last admin");
    } finally {
      restore();
    }
  });

  it("locks the trigger and ignores a second act while one is in flight", async () => {
    // A role PATCH that never resolves pins `busy`, which disables the kebab
    // — without it a fast double-click fires the mutation twice.
    let release: (() => void) | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Promise<Response>((resolve) => {
          release = () => resolve(new Response(JSON.stringify({})));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    }) as typeof fetch;
    try {
      renderRow({ id: "u9" }, "me");
      await pick("Promote to admin");
      await waitFor(() => expect((trigger() as HTMLButtonElement).disabled).toBe(true));
      // The title's second half, pinned: the locked trigger opens nothing, so
      // a second act cannot even be reached while the first is in flight.
      fireEvent.keyDown(trigger(), { key: "ArrowDown" });
      fireEvent.click(trigger());
      expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
      // Releasing inside act(): the resolved PATCH triggers `setBusy(false)`
      // and an un-wrapped resolve warns (and can leak into the next test).
      await act(async () => {
        release?.();
      });
      await waitFor(() => expect((trigger() as HTMLButtonElement).disabled).toBe(false));
    } finally {
      globalThis.fetch = original;
    }
  });

  it("opens the password dialog from the menu, submits once, and shows the new password once", async () => {
    const { patches, restore } = mockFetch(() => ok({ sessionsRevoked: 3 }));
    try {
      renderRow({ id: "u9", email: "dana@example.com" });
      await pick("Reset password", "dana@example.com");
      const dialog = await screen.findByRole("dialog");
      // The title names the act, not the person; the body carries the email.
      expect(screen.getByRole("heading", { name: "Reset password" })).toBeDefined();
      expect(dialog.textContent).toMatch(/new password for dana@example\.com/i);
      expect(dialog.textContent).toMatch(/signs them out of every device/i);
      expect(dialog.textContent).toMatch(/won't be notified/i);
      const button = screen.getByRole("button", { name: "Reset and sign out" });
      // Confirm-gated: too short keeps the act dead.
      fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("New password"), { target: { value: "correct-horse-battery" } });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(button);
      await waitFor(() => expect(patches.length).toBe(1));
      expect(patches[0]?.url).toBe("/api/users/u9/password");
      expect(patches[0]?.body).toEqual({ password: "correct-horse-battery" });
      await waitFor(() => expect(screen.getByText(/Signed out of 3 sessions\./)).toBeDefined());
      // Shown once, readable: the admin must be able to pass it on.
      expect(screen.getByText("correct-horse-battery")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("asks before disabling, and says what the mechanism cannot", async () => {
    const { patches, restore } = mockFetch(() => ok({ sessionsRevoked: 2 }));
    try {
      renderRow({ id: "u9", email: "dana@example.com" });
      await pick("Disable account", "dana@example.com");
      const dialog = await screen.findByRole("dialog");
      // One static title for a repeated act, the email in the body (same
      // shape the reset dialog took the same day).
      expect(screen.getByRole("heading", { name: "Disable account" })).toBeDefined();
      // The facts a disabled account does not announce for itself, named
      // plainly and once each (operator's rewrite, 2026-09-24): what stops,
      // including the nodes the 2026-09-24 ruling added, and the silence
      // that follows.
      expect(dialog.textContent).toMatch(/Everything stops for dana@example\.com/i);
      expect(dialog.textContent).toMatch(/sign-in, their sessions, their keys and subshells, their nodes/i);
      expect(dialog.textContent).toMatch(/won't be notified/i);
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
      await pick("Disable account");
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
      await pick("Disable account");
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
      await pick("Disable account");
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
      await pick("Enable account");
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
