import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { MODAL_SCROLLER_SELECTOR, shouldResetForeignScroll } from "@/lib/app-scroll-pin";

/**
 * Regression (iPhone PWA, operator report 2026-10-21): the "New subshell"
 * dialog gained a preset line that pushed the form past its `max-h` cap, the
 * user swiped down, and the scroller snapped back to the top immediately.
 * Cause: the terminal's foreign-scroll pin zeroes every scroller outside the
 * terminal while the terminal is engaged OR focus sits on the body — and on
 * iOS Safari a tap-selected option leaves focus on the body, so the dialog's
 * scroller was pinned exactly when it should not have been. The pin now
 * exempts scrollers that live inside an open modal surface (dialog, menu,
 * listbox), by surface rather than by wherever the keyboard happened to leave
 * focus.
 *
 * jsdom cannot reproduce iOS's momentum pan, so this is the strongest
 * assertion the environment allows: the DOM the REAL dialog mounts is fed to
 * the REAL predicate, exactly as `onAnyScroll` feeds it (engaged true, the
 * scroller outside the terminal). A scroller outside the dialog must still
 * read as pinned, so the test cannot pass by exempting everything.
 */
describe("the dialog's scroller outlives the terminal's scroll pin", () => {
  afterEach(() => cleanup());

  it("exempts the DialogContent scroller from shouldResetForeignScroll", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>New subshell</DialogTitle>
          <div>form</div>
        </DialogContent>
      </Dialog>,
    );

    // The scroller is the inner wrapper under the popup (ui/dialog.tsx keeps
    // the cap off the popup itself so the X stays pinned).
    const popup = document.querySelector('[data-slot="dialog-content"]');
    expect(popup).not.toBeNull();
    const scroller = popup?.querySelector<HTMLElement>("[class*='overflow-y-auto']");
    expect(scroller).not.toBeNull();

    // Exactly as onAnyScroll computes it for a scroll event from this
    // scroller on a phone with the terminal engaged or the page idle:
    const pinArgs = {
      touchUi: true,
      engaged: true,
      insideTerminal: false,
      terminalControls: scroller?.matches("[data-terminal-controls-scroller]"),
      insideModal: scroller?.closest(MODAL_SCROLLER_SELECTOR) !== null,
    };
    expect(pinArgs.insideModal).toBe(true);
    expect(shouldResetForeignScroll(pinArgs)).toBe(false);

    // The predicate is still live: a foreign scroller outside the dialog is
    // still pinned.
    const foreign = document.createElement("div");
    expect(
      shouldResetForeignScroll({
        touchUi: true,
        engaged: true,
        insideTerminal: false,
        terminalControls: false,
        insideModal: foreign.closest(MODAL_SCROLLER_SELECTOR) !== null,
      }),
    ).toBe(true);
  });
});
