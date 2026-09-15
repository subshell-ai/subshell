import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { AddUserDialog } from "@/components/users/add-user-dialog";

/**
 * The Add user dialog (spec 2026-09-14 §3) — what it sends, and what it does
 * with a refusal.
 *
 * The fields themselves are `NewAccountFields`, tested where they live; what
 * belongs here is the wiring the dialog owns: the submit gate is the shared
 * `newAccountComplete` rather than a second rule, the POST body carries the
 * name the server now requires, and a duplicate email — the one refusal an
 * admin will actually meet — leaves the dialog open with the server's own
 * sentence on it, because closing it would throw away everything typed.
 */
interface Posted {
  url: string;
  body: unknown;
}

function mockFetch(response: () => Response): { posts: Posted[]; restore: () => void } {
  const posts: Posted[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "POST") {
      posts.push({ url: url.pathname, body: JSON.parse(String(init.body)) });
      return Promise.resolve(response());
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { posts, restore: () => (globalThis.fetch = original) };
}

/** Fills the four account fields through the DOM, as a person would. */
function fillForm(over: { name?: string; email?: string; password?: string; confirm?: string } = {}): void {
  const type = (id: string, value: string) => {
    const input = document.getElementById(id);
    if (!input) throw new Error(`no field #${id}`);
    fireEvent.change(input, { target: { value } });
  };
  type("new-user-name", over.name ?? "Ada Lovelace");
  type("new-user-email", over.email ?? "ada@example.com");
  type("new-user-password", over.password ?? "correct-horse-battery");
  type("new-user-password-confirm", over.confirm ?? "correct-horse-battery");
}

const submit = () => screen.getByRole("button", { name: "Add user" });

function renderDialog(onCreated: () => void = () => {}, onOpenChange: (open: boolean) => void = () => {}) {
  return render(<AddUserDialog open onOpenChange={onOpenChange} onCreated={onCreated} />);
}

afterEach(cleanup);

describe("AddUserDialog", () => {
  it("keeps the submit disabled until the whole form is complete", () => {
    const { restore } = mockFetch(() => new Response(JSON.stringify({})));
    try {
      renderDialog();
      expect(submit().hasAttribute("disabled")).toBe(true);
      // A mismatched confirmation is still incomplete — the gate is the
      // shared rule, not "the boxes have text in them".
      fillForm({ confirm: "something-else" });
      expect(submit().hasAttribute("disabled")).toBe(true);
      fillForm();
      expect(submit().hasAttribute("disabled")).toBe(false);
    } finally {
      restore();
    }
  });

  it("posts the name, email, password and role", async () => {
    const { posts, restore } = mockFetch(() => new Response(JSON.stringify({ id: "u2" })));
    try {
      renderDialog();
      fillForm();
      fireEvent.click(submit());
      await waitFor(() => expect(posts.length).toBe(1));
      expect(posts[0]?.url).toBe("/api/users");
      expect(posts[0]?.body).toEqual({
        name: "Ada Lovelace",
        email: "ada@example.com",
        password: "correct-horse-battery",
        role: "user",
      });
    } finally {
      restore();
    }
  });

  it("trims the name and the email it submits", async () => {
    // The shared `normalizeNewAccount`, not a rule of this dialog's own: the
    // setup wizard submits through the same helper, and the two used to
    // disagree about whether a typed name kept its spaces.
    const { posts, restore } = mockFetch(() => new Response(JSON.stringify({ id: "u2" })));
    try {
      renderDialog();
      fillForm({ name: "  Ada Lovelace  ", email: " ada@example.com " });
      fireEvent.click(submit());
      await waitFor(() => expect(posts.length).toBe(1));
      expect(posts[0]?.body).toEqual({
        name: "Ada Lovelace",
        email: "ada@example.com",
        password: "correct-horse-battery",
        role: "user",
      });
    } finally {
      restore();
    }
  });

  it("announces the refusal rather than only colouring it", async () => {
    // Without `role="alert"` a screen-reader user who submits a duplicate
    // email gets a dialog that appears to do nothing at all.
    const { restore } = mockFetch(
      () => new Response(JSON.stringify({ message: "Email already registered" }), { status: 409 }),
    );
    try {
      renderDialog();
      fillForm();
      fireEvent.click(submit());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Email already registered");
    } finally {
      restore();
    }
  });

  it("shows a refused email and STAYS open", async () => {
    // 409 is the refusal an admin meets in practice. Closing on it would
    // discard a filled-in form to show an error nowhere.
    const { restore } = mockFetch(
      () => new Response(JSON.stringify({ message: "Email already registered" }), { status: 409 }),
    );
    const closes: boolean[] = [];
    try {
      renderDialog(
        () => {},
        (open) => closes.push(open),
      );
      fillForm();
      fireEvent.click(submit());
      await waitFor(() => expect(screen.getByText(/Email already registered/)).toBeDefined());
      expect(closes).toEqual([]);
    } finally {
      restore();
    }
  });

  it("closes and reports the new account on success", async () => {
    const { restore } = mockFetch(() => new Response(JSON.stringify({ id: "u2" })));
    let created = 0;
    const closes: boolean[] = [];
    try {
      renderDialog(
        () => created++,
        (open) => closes.push(open),
      );
      fillForm();
      fireEvent.click(submit());
      await waitFor(() => expect(created).toBe(1));
      expect(closes).toContain(false);
    } finally {
      restore();
    }
  });
});

/**
 * The shape of the form, as distinct from what it sends.
 *
 * Role leads because it is the one decision the admin makes ABOUT this person
 * rather than a fact they are transcribing, and a control below a password
 * confirmation is a control people submit past.
 */
describe("AddUserDialog form", () => {
  it("asks for the role before the account fields", () => {
    renderDialog();
    const labels = Array.from(document.querySelectorAll("label")).map((l) => l.textContent);
    expect(labels).toEqual(["Role", "Name", "Email", "Password", "Confirm password"]);
  });

  it("spells the chosen role on the trigger the way the menu spells it", () => {
    // Base UI's `Value` renders the RAW value unless the root is handed an
    // items map, so without one the trigger read "user" under a menu whose
    // items read "User".
    renderDialog();
    expect(screen.getByRole("combobox").textContent).toContain("User");
  });

  it("still starts typing in the Name field", () => {
    // Role leads visually; the first thing typed is still a name, so autoFocus
    // stays on Name rather than following the layout.
    renderDialog();
    expect(document.activeElement?.id).toBe("new-user-name");
  });
});

/**
 * What a dismissal does to what was typed.
 *
 * The spec asked for this and nothing tested it: two passwords live in this
 * form, and `close` — Cancel, the overlay, a successful create — is what
 * clears them. The mount effect's cleanup does NOT: React discards a state
 * update on an unmounted component. So the property worth pinning is that
 * reopening the dialog shows an empty form rather than the last person's
 * password sitting in a box.
 */
describe("AddUserDialog on close", () => {
  /** The dialog as its page holds it: open state outside, dialog mounted throughout. */
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <AddUserDialog open={open} onOpenChange={setOpen} onCreated={() => {}} />
      </>
    );
  }

  it("clears the typed password, so a reopened dialog is blank", async () => {
    render(<Harness />);
    fillForm();
    expect((document.getElementById("new-user-password") as HTMLInputElement).value).toBe("correct-horse-battery");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.getElementById("new-user-password")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(document.getElementById("new-user-password")).not.toBeNull());
    for (const id of ["new-user-name", "new-user-email", "new-user-password", "new-user-password-confirm"]) {
      expect((document.getElementById(id) as HTMLInputElement).value, id).toBe("");
    }
  });
});
