import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";

/**
 * The opt-in `tooltip` (rail ask): a forward-only icon option's only reveal.
 * Composed with the rail's `render`-merge idiom, so the BUTTON stays the one
 * gesture anchor — options without a tooltip must render byte-identically,
 * which the existing four tests re-assert unchanged.
 */
describe("Segmented tooltip (opt-in per option)", () => {
  afterEach(cleanup);

  it("opens the popup on focus and keeps the button's press semantics", async () => {
    render(
      <Segmented
        ariaLabel="View"
        options={[
          { value: "a", label: "", icon: null, ariaLabel: "Row view", tooltip: "List of subshells" },
          { value: "b", label: "Plain" },
        ]}
        value="a"
        onChange={() => {}}
      />,
    );
    const hinted = screen.getByRole("button", { name: "Row view" });
    expect(hinted.getAttribute("aria-pressed")).toBe("true");
    expect(hinted.getAttribute("type")).toBe("button");
    expect(hinted.hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
    // An option with no tooltip is NOT given the trigger marker: the merged
    // handler set must not sneak into the untouched path.
    expect(screen.getByRole("button", { name: "Plain" }).hasAttribute("data-base-ui-tooltip-trigger")).toBe(false);
    fireEvent.focus(hinted);
    expect((await screen.findByText("List of subshells")).textContent).toBe("List of subshells");
  });

  it("choosing a hinted option still reports its value", () => {
    const picked: string[] = [];
    render(
      <Segmented
        ariaLabel="View"
        options={[
          { value: "a", label: "", ariaLabel: "Row view", tooltip: "List of subshells" },
          { value: "b", label: "Plain" },
        ]}
        value="a"
        onChange={(v) => picked.push(v)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Plain" }));
    expect(picked).toEqual(["b"]);
  });
});

const OPTIONS: SegmentedOption<"existing" | "new">[] = [
  { value: "existing", label: "Existing subshell" },
  { value: "new", label: "New subshell" },
];

describe("Segmented", () => {
  afterEach(cleanup);

  it("keeps option labels as accessible names and presses only the current one", () => {
    render(<Segmented ariaLabel="What to add" options={OPTIONS} value="new" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "New subshell" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Existing subshell" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking any option reports exactly its value", () => {
    const picked: string[] = [];
    render(<Segmented ariaLabel="What to add" options={OPTIONS} value="existing" onChange={(v) => picked.push(v)} />);
    fireEvent.click(screen.getByRole("button", { name: "New subshell" }));
    fireEvent.click(screen.getByRole("button", { name: "Existing subshell" }));
    expect(picked).toEqual(["new", "existing"]);
  });

  it("renders real type=button buttons, so keyboard Enter/Space activate natively", () => {
    const picked: string[] = [];
    render(<Segmented ariaLabel="What to add" options={OPTIONS} value="existing" onChange={(v) => picked.push(v)} />);
    for (const btn of screen.getAllByRole("button")) {
      expect(btn.tagName).toBe("BUTTON");
      expect(btn.getAttribute("type")).toBe("button");
    }
    // A focused button activated by the platform click path (what Enter/Space
    // dispatch on a real `<button>`) reports its value.
    const target = screen.getByRole("button", { name: "New subshell" });
    target.focus();
    fireEvent.click(target);
    expect(picked).toEqual(["new"]);
  });

  it("dense halves the button box height; without it every button keeps the shared sm table", () => {
    // The byte-identical guarantee for every non-dense consumer (home tiles
    // toggle, the dialogs): the pin below is the button's ACTUAL className,
    // h-8 included. `dense` is opt-in and merges `h-6` — the rail's density
    // ask (24px, the cell grid's own rhythm); `cn` is twMerge, so h-6 wins
    // over the variant's h-8 in any order, and px-3 (width) stays untouched.
    const { unmount } = render(<Segmented ariaLabel="What to add" options={OPTIONS} value="new" onChange={() => {}} />);
    const plain = screen.getByRole("button", { name: "New subshell" });
    expect(plain.className).toContain("h-8");
    expect(plain.className).not.toContain("h-6");
    unmount();
    render(<Segmented ariaLabel="What to add" options={OPTIONS} value="new" onChange={() => {}} dense />);
    for (const btn of screen.getAllByRole("button")) {
      expect(btn.className).toContain("h-6");
      expect(btn.className).not.toContain("h-8");
      // Width untouched: the operator rejected width changes twice.
      expect(btn.className).toContain("px-3");
    }
  });

  it("fills by default and sizes to its words with fill=false", () => {
    // The page-tab rule (design-system.md, 2026-09-25): the tab strip is
    // content-sized; the in-row switch keeps the equal share.
    const { unmount } = render(<Segmented ariaLabel="What to add" options={OPTIONS} value="new" onChange={() => {}} />);
    expect(screen.getByRole("group").className).not.toContain("w-fit");
    expect(screen.getByRole("button", { name: "New subshell" }).className).toContain("flex-1");
    unmount();
    render(<Segmented ariaLabel="What to add" options={OPTIONS} value="new" onChange={() => {}} fill={false} />);
    expect(screen.getByRole("group").className).toContain("w-fit");
    expect(screen.getByRole("button", { name: "New subshell" }).className).not.toContain("flex-1");
  });
});
