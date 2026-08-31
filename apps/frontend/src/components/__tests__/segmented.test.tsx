import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";

const OPTIONS: SegmentedOption<"existing" | "new">[] = [
  { value: "existing", label: "Existing session" },
  { value: "new", label: "New session" },
];

describe("Segmented", () => {
  afterEach(cleanup);

  it("keeps option labels as accessible names and presses only the current one", () => {
    render(<Segmented ariaLabel="What to add" options={OPTIONS} value="new" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "New session" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Existing session" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking any option reports exactly its value", () => {
    const picked: string[] = [];
    render(<Segmented ariaLabel="What to add" options={OPTIONS} value="existing" onChange={(v) => picked.push(v)} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(screen.getByRole("button", { name: "Existing session" }));
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
    const target = screen.getByRole("button", { name: "New session" });
    target.focus();
    fireEvent.click(target);
    expect(picked).toEqual(["new"]);
  });
});
