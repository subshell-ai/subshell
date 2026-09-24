import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The shadcn Base UI tooltip, split form. `open` is controlled so the popup
 * renders without a pointer sequence happy-dom cannot reproduce; what these
 * cases hold are the two decisions of 2026-09-24: the popup is a real page
 * element (that is the whole zoom story — native `title` paints at the
 * SYSTEM font size and ctrl +/- walks right past it), and its text is
 * `text-body`, one step up the scale from `detail` by operator call.
 */
afterEach(cleanup);

describe("ui/tooltip", () => {
  it("renders the popup as a page element at body size", async () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>hover me</TooltipTrigger>
          <TooltipContent>the reveal</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    // `findBy*` rather than `getBy`: the popup's positioner measures in an
    // async effect after mount, and waitFor drives that flush INSIDE act —
    // a synchronous getBy plus cleanup over a pending update is what made
    // these cases emit "not wrapped in act" intermittently (review 2026-09-24,
    // finding 7).
    // Base UI splits the popup into a positioned wrapper (which carries the
    // classes) and an inner content element; walk up from the text.
    const popup = await screen.findByText("the reveal");
    expect(popup.closest("[class*='text-body']")).not.toBeNull();
    // The trigger identifier is what merges the tooltip onto the trigger
    // element rather than beside it (see the sidebar row's four-consumer
    // Link for why that matters).
    expect(screen.getByText("hover me").hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
  });

  it("caller classes merge onto the popup, so multi-line content can ask for pre-line", async () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>t</TooltipTrigger>
          <TooltipContent className="whitespace-pre-line break-words">{"Name: x\nNode: y"}</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const popup = await screen.findByText(/Name: x/);
    expect(popup.closest(".whitespace-pre-line")).not.toBeNull();
    expect(popup.textContent).toContain("Node: y");
  });

  it("draws no arrow by default", async () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>t</TooltipTrigger>
          <TooltipContent>plain</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const popup = await screen.findByText("plain");
    const wrapper = popup.closest("[class*='text-body']");
    // The arrow lives INSIDE the popup as a sibling of the content, which is
    // why these walk from the wrapper rather than `closest` from the text.
    expect(wrapper?.querySelector(".rotate-45")).toBeNull();
  });

  it("arrow tracks the rendered side, not just the requested one", async () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>t</TooltipTrigger>
          <TooltipContent side="right" arrow>
            beside
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const popup = await screen.findByText("beside");
    // The tip is Base UI's own Arrow (aria-hidden, rotated square) sitting in
    // the popup, and it carries `data-side` — the side the popup ACTUALLY
    // rendered on. The primitive's arrow classes key off that attribute
    // rather than the `side` prop, so a flip near a viewport edge drags the
    // tip (and its two visible faces) along with it.
    const arrow = popup.closest("[class*='text-body']")?.querySelector(".rotate-45");
    expect(arrow).not.toBeNull();
    expect(arrow?.getAttribute("aria-hidden")).toBe("true");
    expect(arrow?.hasAttribute("data-side")).toBe(true);
  });
});
