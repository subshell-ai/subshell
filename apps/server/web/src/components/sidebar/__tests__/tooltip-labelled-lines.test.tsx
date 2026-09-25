import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { TooltipLabelledLines } from "@/components/sidebar/TooltipLabelledLines";

afterEach(cleanup);

/**
 * The rail's tooltip text is a string contract (`subshellRowTooltip`, tested
 * as one); this renderer only dresses it. What is pinned: each line becomes
 * its own block with the LABEL bolded at the font's strong weight (the
 * design system has one bold), the FIRST ": " is the only split point so a
 * value that itself contains ": " stays whole, and a line the renderer does
 * not recognise is kept, never dropped.
 */
describe("TooltipLabelledLines", () => {
  it("bolds our label constants at the first colon-space", () => {
    const { container } = render(<TooltipLabelledLines text={"Name: auth-refactor\nStatus: working"} />);
    const lines = Array.from(container.children);
    expect(lines).toHaveLength(2);
    const firstLabel = lines[0]?.querySelector("span span");
    expect(firstLabel?.textContent).toBe("Name:");
    expect(firstLabel?.className).toContain("font-strong");
    expect(lines[0]?.textContent).toBe("Name: auth-refactor");
  });

  it("splits only at the FIRST colon-space, so values keep theirs", () => {
    const { container } = render(<TooltipLabelledLines text={"Directory: /tmp/a: b"} />);
    const label = container.querySelector("span span");
    expect(label?.textContent).toBe("Directory:");
    // The value half, verbatim — the path's own ": " survives untouched.
    expect(container.textContent).toBe("Directory: /tmp/a: b");
  });

  it("renders an unlabelled line as-is rather than dropping it", () => {
    const { container } = render(<TooltipLabelledLines text={"no label here"} />);
    expect(container.textContent).toBe("no label here");
    expect(container.querySelector("span span")).toBeNull();
  });
});
