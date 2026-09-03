import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initialsOf, UserMenu } from "@/components/user-menu";

/**
 * The signed-in user menu replacing the bare Logout button (spec 2026-09-02
 * settings-split §3). Props-only contract — queries live in the sidebar.
 * Base UI popups render under happy-dom (proven by combobox.test.tsx).
 */
afterEach(cleanup);

describe("initialsOf", () => {
  it("takes the name's first letter, falling back to the email, uppercased", () => {
    expect(initialsOf("Thea", "t@example.com")).toBe("T");
    expect(initialsOf("  ", "theo@x.io")).toBe("T");
    expect(initialsOf("", "")).toBe("?");
  });
});

describe("UserMenu", () => {
  it("shows the user and offers Account settings + Sign out", async () => {
    const account: string[] = [];
    const signed: string[] = [];
    render(
      <UserMenu
        name="Thea"
        email="thea@example.com"
        collapsed={false}
        onAccountSettings={() => account.push("a")}
        onSignOut={() => signed.push("s")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Thea|thea@example.com/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Account settings" }));
    expect(account).toEqual(["a"]);
    // Choosing an item closes the menu; reopen for the second action.
    fireEvent.click(screen.getByRole("button", { name: /Thea|thea@example.com/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(signed).toEqual(["s"]);
  });
});
