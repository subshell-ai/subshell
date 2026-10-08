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
    // The first CHARACTER, never a lone UTF-16 surrogate half.
    expect(initialsOf("🚀 Thea", "x@y.z")).toBe("🚀");
  });
});

describe("UserMenu", () => {
  it("shows the user and offers Preferences, Account settings, About + Sign out", async () => {
    const prefs: string[] = [];
    const account: string[] = [];
    const about: string[] = [];
    const signed: string[] = [];
    render(
      <UserMenu
        name="Thea"
        email="thea@example.com"
        collapsed={false}
        onPreferences={() => prefs.push("p")}
        onAccountSettings={() => account.push("a")}
        onAbout={() => about.push("i")}
        onSignOut={() => signed.push("s")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Thea|thea@example.com/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Preferences" }));
    expect(prefs).toEqual(["p"]);
    // Choosing an item closes the menu; reopen for the next action.
    fireEvent.click(screen.getByRole("button", { name: /Thea|thea@example.com/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Account settings" }));
    expect(account).toEqual(["a"]);
    // About carries no admin gate: it is offered to whoever the menu is for.
    fireEvent.click(screen.getByRole("button", { name: /Thea|thea@example.com/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "About Subshell" }));
    expect(about).toEqual(["i"]);
    fireEvent.click(screen.getByRole("button", { name: /Thea|thea@example.com/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(signed).toEqual(["s"]);
  });

  it("offers Feedback as a real link to the project's issue list, above About", async () => {
    render(
      <UserMenu
        name="Thea"
        email="thea@example.com"
        collapsed={false}
        onPreferences={() => {}}
        onAccountSettings={() => {}}
        onAbout={() => {}}
        onSignOut={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Thea|thea@example.com/ }));
    const feedback = await screen.findByRole("menuitem", { name: "Feedback" });
    // A real anchor, not a button that fakes one: `lib/desktop-links.ts`
    // claims `a[target="_blank"]` in a desktop webview and hands the URL to
    // the system browser, so this markup is what makes the row work there.
    expect(feedback.tagName).toBe("A");
    expect(feedback.getAttribute("href")).toBe("https://github.com/subshell-ai/subshell/issues");
    expect(feedback.getAttribute("target")).toBe("_blank");
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
    expect(items.indexOf("Feedback")).toBe(items.indexOf("About Subshell") - 1);
  });
});

/**
 * The header-card additions (spec 2026-10-07 §B): the version row the footer
 * used to carry folds into this menu as a detail line, and its amber marker
 * survives OUTSIDE the menu as a dot on the avatar - a status light a person
 * has to open something to see is no light at all.
 */
describe("UserMenu version + update additions", () => {
  const base = {
    name: "Thea",
    email: "thea@example.com",
    collapsed: false,
    onPreferences: () => {},
    onAccountSettings: () => {},
    onAbout: () => {},
    onSignOut: () => {},
  };
  const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /Thea/ }));

  it("carries the server version and instance name as one detail line", async () => {
    render(<UserMenu {...base} serverVersion="0.11.1" instanceName="Test plane" />);
    openMenu();
    expect(await screen.findByText("Subshell Server 0.11.1 · Test plane")).toBeTruthy();
  });

  it("renders no version line while both reads are pending", async () => {
    render(<UserMenu {...base} />);
    openMenu();
    await screen.findByRole("menuitem", { name: "Sign out" });
    expect(screen.queryByText(/Subshell Server/)).toBeNull();
  });

  it("gives the news a dot on the avatar and a row that leads to Updates", async () => {
    const opens: string[] = [];
    const { container } = render(
      <UserMenu {...base} serverVersion="0.11.1" updateNotice="0.12.0" onOpenUpdates={() => opens.push("u")} />,
    );
    // The dot sits on the trigger, visible before anything opens.
    expect(container.querySelector(".bg-warning")).not.toBeNull();
    // The dot is aria-hidden, so its news reaches assistive tech through the
    // trigger's accessible name, before anything opens.
    expect(screen.getByRole("button", { name: /Account: Thea/ }).getAttribute("aria-label")).toContain(
      "Update available: v0.12.0",
    );
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Update available: v0.12.0" }));
    expect(opens).toEqual(["u"]);
  });

  it("renders no dot and no row without a notice", async () => {
    const { container } = render(<UserMenu {...base} serverVersion="0.11.1" />);
    expect(container.querySelector(".bg-warning")).toBeNull();
    // Quiet trigger, quiet name: the notice only rides along with the dot.
    expect(screen.getByRole("button", { name: /Account: Thea/ }).getAttribute("aria-label")).toBe("Account: Thea");
    openMenu();
    await screen.findByRole("menuitem", { name: "Sign out" });
    expect(screen.queryByRole("menuitem", { name: /Update available/ })).toBeNull();
  });

  it("shows the version line alone when the instance name never arrives", async () => {
    render(<UserMenu {...base} serverVersion="0.11.1" />);
    openMenu();
    expect(await screen.findByText("Subshell Server 0.11.1")).toBeTruthy();
  });
});
