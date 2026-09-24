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
});
