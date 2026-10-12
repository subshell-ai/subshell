import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render as renderReact, screen } from "@testing-library/react";
import type { ReactElement } from "react";
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

function render(row: ReactElement) {
  return renderReact(
    <table>
      <tbody>{row}</tbody>
    </table>,
  );
}

function previewOf(label: string): string | null {
  return screen.getByRole("button", { name: label }).closest("tr")?.cells[1]?.textContent ?? null;
}

describe("PromptPageRow", () => {
  it("shows the first body line in its own preview column", () => {
    render(<PromptPageRow {...base} />);
    expect(previewOf("Kickoff")).toBe("start the task");
  });

  it("uses an absence placeholder for a blank first line", () => {
    render(<PromptPageRow {...base} body={"\nsecond line"} />);
    expect(previewOf("Kickoff")).toBe("—");
  });

  it("treats a whitespace-only first line as blank", () => {
    render(<PromptPageRow {...base} body={"   \nsecond line"} />);
    expect(previewOf("Kickoff")).toBe("—");
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
