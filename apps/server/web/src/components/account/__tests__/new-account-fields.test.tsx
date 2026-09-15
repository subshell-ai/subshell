import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  EMPTY_NEW_ACCOUNT,
  NewAccountFields,
  type NewAccountValue,
  newAccountComplete,
  normalizeNewAccount,
} from "@/components/account/new-account-fields";
import { PASSWORD_REQUIREMENT } from "@/lib/password";

/**
 * The account form is now ONE component rendered by two callers — the setup
 * wizard's first screen and the admin's Add user dialog — so the rules it
 * carries are tested here rather than through either caller.
 *
 * Two of them are about WHEN to tell someone off, which is the half that a
 * reimplementation gets wrong: the requirement line is an instruction until
 * something has been typed and only then a complaint, and the mismatch line
 * waits for the confirm box to be left rather than shouting at every
 * keystroke of a password being entered correctly.
 */
const FULL: NewAccountValue = {
  name: "Ada",
  email: "ada@example.com",
  password: "correct-horse-battery",
  confirmPassword: "correct-horse-battery",
};

/** Renders the fields as a controlled input would drive them, one edit deep. */
function renderFields(value: Partial<NewAccountValue> = {}, props: { idPrefix?: string } = {}) {
  const merged = { ...EMPTY_NEW_ACCOUNT, ...value };
  return render(<NewAccountFields value={merged} onChange={() => {}} idPrefix={props.idPrefix} />);
}

describe("newAccountComplete", () => {
  it("is false for an empty value", () => {
    expect(newAccountComplete(EMPTY_NEW_ACCOUNT)).toBe(false);
  });

  it("is false for a whitespace-only name", () => {
    expect(newAccountComplete({ ...FULL, name: "   " })).toBe(false);
  });

  it("is false for a whitespace-only email", () => {
    expect(newAccountComplete({ ...FULL, email: "  " })).toBe(false);
  });

  it("is false for a password below the minimum", () => {
    expect(newAccountComplete({ ...FULL, password: "short", confirmPassword: "short" })).toBe(false);
  });

  it("is false when the confirmation differs", () => {
    expect(newAccountComplete({ ...FULL, confirmPassword: "correct-horse-batteryy" })).toBe(false);
  });

  it("is true once everything is typed and consistent", () => {
    expect(newAccountComplete(FULL)).toBe(true);
  });
});

/**
 * The value a caller SUBMITS, as distinct from the value it holds.
 *
 * It exists because the two callers disagreed: the Add user dialog trimmed on
 * its way out and the setup wizard sent both fields raw to better-auth, so a
 * name typed with spaces survived first run with them. One exported helper is
 * the fix, and the passwords staying untouched is the part worth pinning —
 * a trailing space is a character of the secret, and trimming it would create
 * a password nobody can sign in with.
 */
describe("normalizeNewAccount", () => {
  it("trims the name and the email", () => {
    expect(normalizeNewAccount({ ...FULL, name: "  Ada  ", email: "  ada@example.com " })).toEqual({
      ...FULL,
      name: "Ada",
      email: "ada@example.com",
    });
  });

  it("leaves both passwords exactly as typed", () => {
    const padded = { ...FULL, password: " hunter2-hunter2 ", confirmPassword: " hunter2-hunter2 " };
    const normalized = normalizeNewAccount(padded);
    expect(normalized.password).toBe(" hunter2-hunter2 ");
    expect(normalized.confirmPassword).toBe(" hunter2-hunter2 ");
  });

  it("returns a new object rather than editing the caller's state", () => {
    const held = { ...FULL, name: "  Ada  " };
    normalizeNewAccount(held);
    expect(held.name).toBe("  Ada  ");
  });
});

describe("NewAccountFields", () => {
  afterEach(cleanup);

  it("renders the four labelled boxes setup has always asked for", () => {
    renderFields();
    expect(screen.getByLabelText("Name")).toBeDefined();
    expect(screen.getByLabelText("Email")).toBeDefined();
    expect(screen.getByLabelText("Password")).toBeDefined();
    expect(screen.getByLabelText("Confirm password")).toBeDefined();
  });

  it("states the password requirement quietly while the box is empty", () => {
    renderFields();
    const line = screen.getByText(PASSWORD_REQUIREMENT);
    expect(line.className).toContain("text-muted-foreground");
    expect(line.className).not.toContain("text-destructive");
  });

  it("turns the requirement red once something too short has been typed", () => {
    renderFields({ password: "abc" });
    const line = screen.getByText(PASSWORD_REQUIREMENT);
    expect(line.className).toContain("text-destructive");
  });

  it("goes quiet again once the password is long enough", () => {
    renderFields({ password: FULL.password });
    const line = screen.getByText(PASSWORD_REQUIREMENT);
    expect(line.className).toContain("text-muted-foreground");
  });

  it("describes the password box with the requirement line", () => {
    renderFields();
    const box = screen.getByLabelText("Password");
    const describedBy = box.getAttribute("aria-describedby");
    expect(describedBy).toBe("password-requirement");
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(PASSWORD_REQUIREMENT);
  });

  it("asks the browser for a new password on both boxes, never a saved one", () => {
    renderFields();
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText("Confirm password").getAttribute("autocomplete")).toBe("new-password");
  });

  it("says nothing about a mismatch before the confirm box has been left", () => {
    renderFields({ password: FULL.password, confirmPassword: "different-enough" });
    expect(screen.queryByText("Passwords do not match")).toBeNull();
  });

  it("flags the mismatch once the confirm box has been blurred", () => {
    renderFields({ password: FULL.password, confirmPassword: "different-enough" });
    fireEvent.blur(screen.getByLabelText("Confirm password"));
    expect(screen.getByText("Passwords do not match")).toBeDefined();
  });

  it("stays silent after a blur when the two agree", () => {
    renderFields(FULL);
    fireEvent.blur(screen.getByLabelText("Confirm password"));
    expect(screen.queryByText("Passwords do not match")).toBeNull();
  });

  it("prefixes every id so two copies on one page cannot collide", () => {
    renderFields({}, { idPrefix: "new-user" });
    expect(screen.getByLabelText("Name").id).toBe("new-user-name");
    expect(screen.getByLabelText("Email").id).toBe("new-user-email");
    expect(screen.getByLabelText("Password").id).toBe("new-user-password");
    expect(screen.getByLabelText("Confirm password").id).toBe("new-user-password-confirm");
    expect(screen.getByLabelText("Password").getAttribute("aria-describedby")).toBe("new-user-password-requirement");
  });

  it("reports each edit as a whole value, so a caller holds one state", () => {
    const seen: NewAccountValue[] = [];
    render(<NewAccountFields value={EMPTY_NEW_ACCOUNT} onChange={(next) => seen.push(next)} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    expect(seen).toEqual([{ ...EMPTY_NEW_ACCOUNT, name: "Ada" }]);
  });
});
