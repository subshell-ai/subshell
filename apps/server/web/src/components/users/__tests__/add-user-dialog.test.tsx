import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
