import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ArchSplitButton } from "../ui/arch-split";

afterEach(cleanup);

const OPTIONS = [
  { key: "darwin-arm64", label: "Apple silicon (.dmg)" },
  { key: "darwin-x64", label: "Intel (.dmg)" },
] as const;

function setup(selected = "darwin-arm64") {
  const picks: string[] = [];
  render(
    <ArchSplitButton
      label="Download for Apple silicon (.dmg)"
      href="https://example.invalid/arm.dmg"
      options={OPTIONS}
      selected={selected}
      onSelect={(key) => picks.push(key)}
    />,
  );
  return { picks };
}

const chevron = () => screen.getByRole("button", { name: "Choose which Mac build" });

describe("ArchSplitButton", () => {
  test("renders the download anchor and a closed menu button — the menu is not in the page until asked", () => {
    setup();
    expect(screen.getByRole("link", { name: /Download for Apple silicon/ })).toBeTruthy();
    expect(chevron()).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    expect(chevron().getAttribute("aria-haspopup")).toBe("menu");
  });

  test("the chevron opens a radiogroup menu with the selection marked", () => {
    setup();
    fireEvent.click(chevron());
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["Apple silicon (.dmg)", "Intel (.dmg)"]);
    expect(items[0]?.getAttribute("aria-checked")).toBe("true");
    expect(items[1]?.getAttribute("aria-checked")).toBe("false");
    expect(menu).toBeTruthy();
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
  });

  test("picking Intel reports the choice and closes the menu", () => {
    const { picks } = setup();
    fireEvent.click(chevron());
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Intel (.dmg)" }));
    expect(picks).toEqual(["darwin-x64"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("Escape closes and returns focus to the chevron", () => {
    setup();
    fireEvent.click(chevron());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chevron());
  });

  test("ArrowDown from the chevron opens and lands on the current selection", () => {
    setup("darwin-x64");
    chevron().focus();
    fireEvent.keyDown(chevron(), { key: "ArrowDown" });
    const items = screen.getAllByRole("menuitemradio");
    expect(document.activeElement).toBe(items[1]);
  });

  test("ArrowUp/ArrowDown walk the items and wrap", () => {
    setup();
    fireEvent.click(chevron());
    const items = screen.getAllByRole("menuitemradio");
    // opened onto the selected item (Apple silicon, index 0):
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
  });

  test("a pointerdown outside the control closes it; inside does not", () => {
    setup();
    fireEvent.click(chevron());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(chevron());
    fireEvent.pointerDown(chevron());
    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  // Pins for the chevron's explicit Enter/Space handler: native buttons
  // already activate on Enter, the handler is for engines with odd defaults,
  // and its preventDefault is what stops the keypress from ALSO firing the
  // click toggle (which would reopen→close). Nothing else exercises it.
  test("Enter on the chevron opens the menu (keyboard activation, not just click)", () => {
    setup();
    chevron().focus();
    fireEvent.keyDown(chevron(), { key: "Enter" });
    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  test("Space on the chevron opens the menu", () => {
    setup();
    chevron().focus();
    fireEvent.keyDown(chevron(), { key: " " });
    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  test("while open, the chevron's aria-controls names the menu it owns", () => {
    setup();
    fireEvent.click(chevron());
    const menuId = screen.getByRole("menu").getAttribute("id");
    expect(menuId).toBeTruthy();
    expect(chevron().getAttribute("aria-controls")).toBe(menuId);
  });

  test("re-opening resets focus to the selection, not the last hovered row", () => {
    setup();
    fireEvent.click(chevron());
    const items = screen.getAllByRole("menuitemradio");
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    fireEvent.keyDown(items[1], { key: "Escape" });
    fireEvent.click(chevron());
    expect(document.activeElement).toBe(screen.getAllByRole("menuitemradio")[0]);
  });
});
