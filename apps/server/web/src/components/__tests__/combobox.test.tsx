import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ComboboxOption, SearchableSelect } from "@/components/ui/combobox";

const OPTIONS: ComboboxOption[] = [
  { value: "a", label: "Alpha · linux/x64" },
  { value: "b", label: "Beta · darwin/arm64", disabled: true, reason: "no pi here" },
];
const ICONED: ComboboxOption[] = [{ value: "c", label: "Claude Code", icon: "🤖" }];

afterEach(cleanup);

describe("SearchableSelect", () => {
  it("renders a searchable combobox carrying the caller's id and placeholder", () => {
    render(
      <SearchableSelect
        id="picker-node"
        value=""
        onValueChange={() => {}}
        placeholder="Choose a node"
        options={OPTIONS}
      />,
    );
    const input = screen.getByPlaceholderText("Choose a node");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("id")).toBe("picker-node");
  });

  it("shows the selected option's label as the input value", () => {
    render(<SearchableSelect id="x" value="a" onValueChange={() => {}} placeholder="p" options={OPTIONS} />);
    expect((screen.getByPlaceholderText("p") as HTMLInputElement).value).toBe("Alpha · linux/x64");
  });

  it("opens the popup listing enabled and disabled rows with their reasons; the disabled row is inert", async () => {
    const picked: string[] = [];
    render(
      <SearchableSelect
        id="picker-node"
        value=""
        onValueChange={(v: string) => picked.push(v)}
        placeholder="Choose a node"
        options={OPTIONS}
      />,
    );
    const input = screen.getByPlaceholderText("Choose a node") as HTMLInputElement;
    fireEvent.mouseDown(input);
    fireEvent.click(input);

    const alpha = await screen.findByRole("option", { name: /Alpha · linux\/x64/ });
    const beta = await screen.findByRole("option", { name: /Beta · darwin\/arm64/ });
    // Disabled rows stay listed and explain themselves (greying out explains,
    // never hides) — and carry the data-disabled marker Base UI styles on.
    expect(beta.textContent).toContain("no pi here");
    expect(beta.getAttribute("data-disabled")).toBe("");

    fireEvent.click(beta);
    expect(picked).toEqual([]); // inert: a disabled row never fires onValueChange
    fireEvent.click(alpha);
    expect(picked).toEqual(["a"]);
  });
});

describe("SearchableSelect — dialog scroll restoration (2026-09-04)", () => {
  /** Mount the picker inside a stand-in for the Dialog's inner scroller
   * (the element ui/dialog.tsx gives `overflow-y-auto`), and a UA focus
   * scroll in place of the phone's. */
  function renderInScroller() {
    // Mirror ui/dialog.tsx exactly: the Popup element (data-slot) carries a
    // direct child div which is the overflow scroller; form contents mount
    // inside THAT div.
    const popup = document.createElement("div");
    popup.setAttribute("data-slot", "dialog-content");
    const scroller = document.createElement("div");
    popup.appendChild(scroller);
    document.body.appendChild(popup);
    render(<SearchableSelect id="picker-agent" value="" onValueChange={() => {}} placeholder="p" options={OPTIONS} />, {
      container: scroller,
    });
    return scroller;
  }

  it("restores the scroller position the dropdown's focus shifted away", async () => {
    const scroller = renderInScroller();
    const input = screen.getByPlaceholderText("p") as HTMLInputElement;

    fireEvent.pointerDown(input); // captures scrollTop = 0
    // The UA/keyboard shift the phone produces once the input has focus:
    scroller.scrollTop = 59;

    fireEvent.mouseDown(input);
    fireEvent.click(input); // open
    await screen.findByRole("option", { name: /Alpha/ });
    // Base UI closes on an outside PRESS; happy-dom has no transitions, so the
    // close (and the restore) is synchronous afterwards.
    fireEvent.pointerDown(document.body);
    await new Promise((r) => setTimeout(r, 20));
    expect(await screen.queryByRole("option", { name: /Alpha/ })).toBeNull();
    expect(scroller.scrollTop).toBe(0);
    scroller.remove();
  });

  it("renders an option's icon aria-hidden BEFORE the label — the accessible name stays the label", async () => {
    render(<SearchableSelect id="picker-agent" value="" onValueChange={() => {}} placeholder="p" options={ICONED} />);
    const input = screen.getByPlaceholderText("p") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // The name match alone proves the glyph contributes nothing to it: with
    // the icon exposed, the accessible name would read "🤖 Claude Code".
    const option = await screen.findByRole("option", { name: "Claude Code" });
    const icon = option.querySelector("span[aria-hidden]") as HTMLElement;
    expect(icon.textContent).toBe("🤖");
    // aria-hidden on the glyph, BEFORE the label text.
    expect(option.textContent?.startsWith("🤖")).toBe(true);
  });

  it("leaves the scroller alone when nothing shifted (desktop case)", async () => {
    const scroller = renderInScroller();
    scroller.scrollTop = 40; // the user had scrolled the dialog themselves
    const input = screen.getByPlaceholderText("p") as HTMLInputElement;

    fireEvent.pointerDown(input); // captures 40
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await screen.findByRole("option", { name: /Alpha/ });
    fireEvent.keyDown(input, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 20));

    expect(scroller.scrollTop).toBe(40);
    scroller.remove();
  });
});
