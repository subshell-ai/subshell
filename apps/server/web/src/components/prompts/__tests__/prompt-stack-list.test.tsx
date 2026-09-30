import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PromptStackList } from "@/components/prompts/prompt-stack-list";
import type { PromptBlock } from "@/lib/prompt-stack";

/**
 * The launch form's block stack: reorder/remove report through the two
 * callbacks, the full text is one click to read (collapsed by default), and
 * the detail line joins its segments rather than dangling a separator the
 * data cannot fill (the launch-defaults rule, round-6 nit: a custom body may
 * legitimately start with a newline).
 */

afterEach(cleanup);

const saved = (over: Partial<PromptBlock> = {}): PromptBlock => ({
  localId: "b1",
  kind: "saved",
  promptId: "pr1",
  description: "Kickoff",
  body: "start the task",
  ...over,
});

function detailOf(label: string): string | null {
  // The row stacks the label span over the detail span; the detail is the
  // label's next sibling.
  const labelEl = screen.getByText(label, { selector: "span" });
  return labelEl.nextElementSibling?.textContent ?? null;
}

describe("PromptStackList", () => {
  it("a stack block with a blank first line reads 'stack · 1 prompt', no dangling separator", () => {
    render(
      <PromptStackList
        blocks={[saved({ kind: "stack", description: "", stackId: "st1", stackCount: 1, body: "\nsecond only" })]}
        onReorder={() => {}}
        onRemove={() => {}}
      />,
    );
    // The label is the "Untitled" fallback; the detail drops the blank body
    // segment instead of dangling " · ".
    expect(detailOf("Untitled")).toBe("stack · 1 prompt");
  });

  it("a whitespace-only first line counts as blank too (the round-8 trim rule)", () => {
    render(
      <PromptStackList
        blocks={[saved({ kind: "stack", description: "", stackId: "st1", stackCount: 1, body: "   \nsecond only" })]}
        onReorder={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(detailOf("Untitled")).toBe("stack · 1 prompt");
  });

  it("a normal stack block keeps its preview segment", () => {
    render(
      <PromptStackList
        blocks={[saved({ kind: "stack", description: "Set", stackId: "st1", stackCount: 2, body: "joined text" })]}
        onReorder={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(detailOf("Set")).toBe("stack · 2 prompts · joined text");
  });

  it("a plain saved block's detail is just its first line", () => {
    render(<PromptStackList blocks={[saved()]} onReorder={() => {}} onRemove={() => {}} />);
    expect(detailOf("Kickoff")).toBe("start the task");
  });

  it("remove reports the block by localId; the body opens on the expander", () => {
    const removed: string[] = [];
    const { container } = render(
      <PromptStackList blocks={[saved()]} onReorder={() => {}} onRemove={(id) => removed.push(id)} />,
    );
    // Collapsed by default: the full text is UNMOUNTED (the page row's rule),
    // not hidden - the detail preview line is not the body panel.
    expect(container.querySelector("pre")).toBeNull();
    const expander = container.querySelector("button[aria-controls]") as HTMLButtonElement;
    fireEvent.click(expander);
    expect(container.querySelector("pre")?.textContent).toBe("start the task");
    fireEvent.click(screen.getByRole("button", { name: "Remove prompt" }));
    expect(removed).toEqual(["b1"]);
  });
});
