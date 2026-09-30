import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ComboboxOption, SearchableSelect } from "@/components/ui/combobox";

const OPTIONS: ComboboxOption[] = [
  { value: "a", label: "Alpha · linux/x64" },
  { value: "b", label: "Beta · darwin/arm64", disabled: true, reason: "no pi here" },
];
const ICONED: ComboboxOption[] = [{ value: "c", label: "Claude Code", icon: "🤖" }];

// Two grouped rows then an ungrouped one: the header is the group, so it
// renders ONCE above the run, and the trailing row carries none.
const GROUPED: ComboboxOption[] = [
  { value: "t1", label: "Stopped job", group: "Recently terminated" },
  { value: "t2", label: "Another ended", group: "Recently terminated" },
  { value: "r1", label: "Running one" },
];

afterEach(cleanup);

/** Open the popup the way the operator's mouse does (pointer, then click). */
async function openPopup(id = "picker-node", placeholder = "Choose a node") {
  render(<SearchableSelect id={id} value="" onValueChange={() => {}} placeholder={placeholder} options={GROUPED} />);
  const input = screen.getByPlaceholderText(placeholder) as HTMLInputElement;
  fireEvent.mouseDown(input);
  fireEvent.click(input);
  await screen.findByRole("option", { name: /Stopped job/ });
  return input;
}

describe("SearchableSelect — group headers", () => {
  it("renders ONE header above the run, not one per row, and the header is not a row", async () => {
    await openPopup();
    // The group's label shows exactly once for the two grouped rows.
    expect(screen.getAllByText("Recently terminated")).toHaveLength(1);
    // A header is a heading, not a selectable option: three options (t1, t2,
    // r1), and none of them is named after the group.
    expect(screen.getAllByRole("option")).toHaveLength(3);
    for (const opt of screen.getAllByRole("option")) {
      expect(opt.textContent).not.toContain("Recently terminated");
    }
  });

  it("the header follows the FILTER: it stays while a member matches, and goes when none do", async () => {
    const input = await openPopup();
    // Query only a grouped row: the group still has a member, so the header
    // is there even though t1 is filtered out (the surviving t2 opens the run).
    fireEvent.change(input, { target: { value: "ended" } });
    await waitFor(() => expect(screen.queryByRole("option", { name: /Running one/ })).toBeNull());
    expect(screen.getByRole("option", { name: /Another ended/ })).toBeDefined();
    expect(screen.getAllByText("Recently terminated")).toHaveLength(1);
    // Query an UNGROUPED row: no grouped member survives, so no orphan header.
    fireEvent.change(input, { target: { value: "Running" } });
    await waitFor(() => expect(screen.queryByRole("option", { name: /Stopped job/ })).toBeNull());
    expect(screen.getByRole("option", { name: /Running one/ })).toBeDefined();
    expect(screen.queryByText("Recently terminated")).toBeNull();
  });
});

// The copy picker's "3 each, search to dig deeper" (operator ruling 2026-09-29,
// 4-each first, re-ruled the same day) on top of the group headers: the preview
// cap trims each category's calm view, but a typed query lifts it so the deep
// list stays reachable.
const CAP_TWO: ComboboxOption[] = [
  ...["Alpha", "Bravo", "Charlie", "Delta"].map((label, i) => ({ value: `a${i}`, label, group: "Active" })),
  ...["One", "Two", "Three", "Four"].map((label, i) => ({
    value: `t${i}`,
    label: `Stopped ${label}`,
    group: "Recently terminated",
  })),
];

describe("SearchableSelect — group preview cap", () => {
  it("shows only the cap per group in the calm view", async () => {
    render(
      <SearchableSelect
        id="picker-copy"
        value=""
        onValueChange={() => {}}
        placeholder="p"
        options={CAP_TWO}
        groupPreviewLimit={3}
      />,
    );
    const input = screen.getByPlaceholderText("p");
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await screen.findByRole("option", { name: /Alpha/ });
    // 3 of each category = 6 rows; the 4th of each is trimmed.
    expect(screen.getAllByRole("option")).toHaveLength(6);
    expect(screen.queryByRole("option", { name: /Delta/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Stopped Four/ })).toBeNull();
    // Both headers show, once.
    expect(screen.getByText("Active")).toBeDefined();
    expect(screen.getByText("Recently terminated")).toBeDefined();
  });

  it("the cap trims the NAVIGATED set: keyboard focus never stops on an unrendered row", async () => {
    // The defect this pins (round-2 review): when the cap only hid rows at
    // render time, Base UI still cycled the full filtered set, so the 4th
    // ArrowDown highlighted an invisible row - the list looked dead for a
    // press and Enter committed nothing. With the set trimmed, every highlight
    // lands on a row that is on screen.
    render(
      <SearchableSelect
        id="picker-copy"
        value=""
        onValueChange={() => {}}
        placeholder="p"
        options={CAP_TWO}
        groupPreviewLimit={3}
      />,
    );
    const input = screen.getByPlaceholderText("p") as HTMLInputElement;
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await screen.findByRole("option", { name: /Alpha/ });
    const seen: (string | null)[] = [];
    for (let i = 0; i < 7; i++) {
      // Six trimmed rows; a seventh stop would be an invisible one.
      fireEvent.keyDown(input, { key: "ArrowDown" });
      // aria-activedescendant is the discriminator: Base UI's WRAP passes
      // through a null-active step (measured identical on an uncapped 3-item
      // list), but the old render-time trim left the highlight on a row that
      // was not in the DOM - the id resolved to MISSING. Every step must
      // point at a row that exists, or at none.
      const ad = input.getAttribute("aria-activedescendant");
      if (ad === null) {
        seen.push(null);
      } else {
        const el = document.getElementById(ad);
        if (!el) throw new Error(`activedescendant ${ad} resolves to nothing - an unrendered keyboard stop`);
        seen.push(el.textContent ?? "");
      }
    }
    // A full cycle of the six rendered rows with wrap's null step, and the
    // trimmed 4th of each group never appears.
    expect(seen).toEqual(["Alpha", "Bravo", "Charlie", "Stopped One", "Stopped Two", "Stopped Three", null]);
  });

  it("a divider renders one hairline above its row and is not selectable", async () => {
    const withDivider: ComboboxOption[] = [
      { value: "r", label: "Recent pick" },
      { value: "o", label: "The others", divider: true },
    ];
    render(<SearchableSelect id="p2" value="" onValueChange={() => {}} placeholder="q" options={withDivider} />);
    const input = screen.getByPlaceholderText("q");
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    const other = await screen.findByRole("option", { name: "The others" });
    const hairline = other.previousElementSibling;
    expect(hairline?.getAttribute("aria-hidden")).toBe("true");
    expect(hairline?.className).toContain("border-t");
    // The divider is not an option: exactly two choices exist, the hairline is
    // a bare rule between them.
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("lifts the cap when a query reaches a trimmed row (search digs deeper)", async () => {
    render(
      <SearchableSelect
        id="picker-copy"
        value=""
        onValueChange={() => {}}
        placeholder="p"
        options={CAP_TWO}
        groupPreviewLimit={3}
      />,
    );
    const input = screen.getByPlaceholderText("p") as HTMLInputElement;
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await screen.findByRole("option", { name: /Alpha/ });
    expect(screen.queryByRole("option", { name: /Delta/ })).toBeNull(); // trimmed
    fireEvent.change(input, { target: { value: "Delta" } });
    // The query lifts the cap: the trimmed Active row is now reachable.
    expect(await screen.findByRole("option", { name: /Delta/ })).toBeDefined();
    fireEvent.change(input, { target: { value: "Four" } });
    expect(await screen.findByRole("option", { name: /Stopped Four/ })).toBeDefined();
  });
});

describe("SearchableSelect", () => {
  it("forwards describedBy to the real input, so hint lines are announced", () => {
    // Visual reading order is not an association: without this the field is
    // announced as "Agent, combobox" and nothing about why every option is
    // greyed. Asserted on the <input> because that IS the closed state here
    // (unlike select.tsx, whose trigger is a button).
    render(
      <SearchableSelect
        id="picker-agent"
        value=""
        onValueChange={() => {}}
        placeholder="Choose an agent"
        options={OPTIONS}
        describedBy="picker-agent-no-agent picker-agent-no-node"
      />,
    );
    expect(screen.getByPlaceholderText("Choose an agent").getAttribute("aria-describedby")).toBe(
      "picker-agent-no-agent picker-agent-no-node",
    );
  });

  it("omits aria-describedby entirely when there is no hint", () => {
    // Not the empty string: an empty `aria-describedby` is a dangling
    // reference, which some screen readers announce as a missing label.
    render(
      <SearchableSelect id="picker-agent" value="" onValueChange={() => {}} placeholder="Pick" options={OPTIONS} />,
    );
    expect(screen.getByPlaceholderText("Pick").hasAttribute("aria-describedby")).toBe(false);
  });

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

describe("SearchableSelect — the popup's bottom edge (uneven-gap report 2026-09-28)", () => {
  // Base UI's Empty is a live region whose ROOT ELEMENT STAYS MOUNTED while
  // items render (its own docs forbid removing/hiding it; only children swap
  // to null). So any padding carried on the Empty element itself is phantom
  // space under the last row in EVERY non-empty popup — the uneven bottom gap.
  const openWith = async (options: ComboboxOption[]) => {
    render(
      <SearchableSelect
        id="picker-node"
        value=""
        onValueChange={() => {}}
        placeholder="p"
        options={options}
        emptyText="Nothing here"
      />,
    );
    const input = screen.getByPlaceholderText("p");
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    const popup = await waitFor(() => {
      const el = document.querySelector('[data-slot="combobox-content"]');
      if (!el) throw new Error("popup did not open");
      return el as HTMLElement;
    });
    return popup.querySelector('[role="status"]') as HTMLElement;
  };

  it("the mounted Empty region owns no padding box and no text while rows show", async () => {
    const status = await openWith(OPTIONS);
    expect(status).not.toBeNull(); // stays mounted — that is Base UI's doctrine, not our bug
    expect(status.childElementCount).toBe(0); // no sentence while rows exist
    expect(status.className).not.toMatch(/(^|\s)(p|px|py|pt|pb)-/); // the phantom 12px strip
  });

  it("still renders the empty sentence inside the live region when there are no rows", async () => {
    const status = await openWith([]);
    // contains, not equals: Base UI sprinkles a word-joiner (U+2060) in the
    // live region so re-setting the same sentence still announces.
    expect(status.textContent).toContain("Nothing here");
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
