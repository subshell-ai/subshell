import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { PathTail } from "@/components/path-tail";

/**
 * The whole point of this component is that the path reads forwards and
 * stays whole: `dir="rtl"` is what moves the CSS ellipsis to the left edge,
 * and the `<bdi>` isolate is what keeps the glyphs from reordering with it.
 * If either is dropped, long paths silently start clipping their leaf again
 * (or a path renders reversed), and no layout failure announces it under
 * happy-dom — so the DOM contract is the regression assertion, and the
 * visual behaviour was verified in a real browser (see the component's
 * JSDoc for the mechanism).
 */
describe("PathTail", () => {
  afterEach(cleanup);

  it("renders the full path inside an rtl line with a bidi isolate", () => {
    const { container } = render(<PathTail path="/home/theo/projects/hmn-vm" className="block text-detail" />);
    const line = container.firstElementChild;
    expect(line?.getAttribute("dir")).toBe("rtl");
    expect(line?.className).toContain("block");
    const isolate = line?.firstElementChild;
    expect(isolate?.tagName).toBe("BDI");
    expect(isolate?.textContent).toBe("/home/theo/projects/hmn-vm");
    expect(screen.getByText("/home/theo/projects/hmn-vm")).toBeTruthy();
  });
});
