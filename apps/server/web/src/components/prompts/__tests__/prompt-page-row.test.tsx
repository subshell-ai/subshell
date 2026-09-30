import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PromptPageRow } from "@/components/prompts/prompt-page-row";

/**
 * The Prompts page row: the expander answers "what is this prompt?" (the
 * FULL text unmounts while closed), the "In N stacks" chip names its panel
 * in aria-controls, and the detail line joins its segments rather than
 * dangling a separator the data cannot fill (the launch-defaults rule, the
 * third site caught in round-7: a body starting with a newline is legal).
 */

const base = {
  description: "Kickoff",
  body: "start the task",
  updatedAt: "2026-09-29T00:00:00.000Z",
  items: [],
};

afterEach(cleanup);

function detailOf(label: string): string | null {
  // This row nests the label in a badge-carrying wrapper: the detail is the
  // WRAPPER's next sibling, not the label's.
  const labelEl = screen.getByText(label, { selector: "span" });
  return labelEl.parentElement?.nextElementSibling?.textContent ?? null;
}

describe("PromptPageRow", () => {
  it("the detail line is the first body line over the updated stamp", () => {
    render(<PromptPageRow {...base} />);
    const detail = detailOf("Kickoff") ?? "";
    expect(detail.startsWith("start the task · updated ")).toBe(true);
  });

  it("a body starting with a newline drops the segment, not a ' · updated' tail", () => {
    render(<PromptPageRow {...base} body={"\nsecond line"} />);
    const detail = detailOf("Kickoff") ?? "";
    expect(detail.startsWith("updated ")).toBe(true);
    expect(detail).not.toContain("·");
  });

  it("a whitespace-only first line is blank too (the round-8 trim rule)", () => {
    render(<PromptPageRow {...base} body={"   \nsecond line"} />);
    const detail = detailOf("Kickoff") ?? "";
    expect(detail.startsWith("updated ")).toBe(true);
    expect(detail).not.toContain("·");
  });

  it("the expander opens the full body and the aria pairing holds", () => {
    const { container } = render(<PromptPageRow {...base} />);
    expect(container.querySelector("pre")).toBeNull(); // unmounted while closed
    const expander = screen.getByRole("button", { name: /Kickoff/ });
    const panelId = expander.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(expander.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expander);
    expect(container.querySelector("pre")?.id).toBe(panelId ?? undefined);
    expect(screen.getByRole("button", { name: /Kickoff/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("no stacks, no chip", () => {
    render(<PromptPageRow {...base} stacks={{ count: 0, open: false, onToggle: () => {}, panelId: "p" }} />);
    expect(screen.queryByRole("button", { name: /^In \d+ stacks?$/ })).toBeNull();
  });

  it("the chip opens its panel (aria-controls names it) and toggles through the callback", () => {
    const toggles: number[] = [];
    const { container } = render(
      <PromptPageRow
        {...base}
        stacks={{ count: 2, open: false, onToggle: () => toggles.push(1), panelId: "prompt-stacks-pr1" }}
      />,
    );
    const chip = screen.getByRole("button", { name: "In 2 stacks" });
    expect(chip.getAttribute("aria-controls")).toBe("prompt-stacks-pr1");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip);
    expect(toggles).toHaveLength(1);
    // The row click never reaches the expander through the chip.
    expect(container.querySelector("pre")).toBeNull();
  });
});
