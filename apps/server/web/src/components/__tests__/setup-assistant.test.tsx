import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SetupAssistant } from "@/components/setup/setup-assistant";

afterEach(cleanup);
const dots = { total: 3, done: 0, current: 0 };

describe("SetupAssistant", () => {
  it("renders title, subtitle, and the primary with its label", () => {
    render(
      <SetupAssistant
        illustration={<span />}
        title="Create Your Account"
        subtitle="Admin."
        dots={dots}
        primary={{ label: "Create Account", onClick: () => {} }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Create Your Account" })).toBeTruthy();
    expect(screen.getByText("Admin.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Account" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
  it("reserves NO room for art when a screen has none", () => {
    // The three /setup screens each opened with a 72px lucide glyph above a
    // heading that said the same thing in words, in a box costing 124px (a
    // 96px floor plus its margin) of a frame met on a laptop. An empty box
    // still reserves that, so the element must be absent rather than blank.
    const { container } = render(
      <SetupAssistant
        title="Create Your Account"
        dots={dots}
        primary={{ label: "Create Account", onClick: () => {} }}
      />,
    );
    // `.min-h-24` IS the 96px floor — the thing that reserves the space, so
    // the thing to assert on. (A broader `[aria-hidden]` also matches the
    // button icons the frame renders.)
    expect(container.querySelector(".min-h-24")).toBeNull();
    // The heading is still the first thing in the frame.
    expect(screen.getByRole("heading", { name: "Create Your Account" })).toBeTruthy();
  });

  it("still renders art when a screen passes some", () => {
    // The frame is one specification with the native assistant, whose Welcome
    // screen carries the wordmark. Removing the prop would have broken that.
    render(
      <SetupAssistant
        illustration={<img alt="" src="/wordmark.png" />}
        title="T"
        dots={dots}
        primary={{ label: "Continue", onClick: () => {} }}
      />,
    );
    expect(document.querySelector(".min-h-24 img")).toBeTruthy();
  });

  it("shows Back and Skip when given, and a pending label while pending", () => {
    render(
      <SetupAssistant
        illustration={<span />}
        title="T"
        dots={dots}
        back={{ onClick: () => {} }}
        skip={{ label: "Skip", onClick: () => {} }}
        primary={{ label: "Start", onClick: () => {}, pending: true, pendingLabel: "Starting…" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    // Cast-and-read, this repo's convention for asserting disabled (see
    // actions-menu.test.tsx) rather than a jest-dom matcher this project
    // doesn't depend on.
    expect((screen.getByRole("button", { name: "Starting…" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("Enter activates an enabled primary, not a disabled one", () => {
    const onClick = mock(() => {});
    const { rerender } = render(
      <SetupAssistant illustration={<span />} title="T" dots={dots} primary={{ label: "Continue", onClick }} />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <SetupAssistant
        illustration={<span />}
        title="T"
        dots={dots}
        primary={{ label: "Continue", onClick, disabled: true }}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  // The bar holds the buttons and nothing else: a control's progress belongs
  // on the thing it acts on, and the bar had room for about twelve characters
  // (operator's call, 2026-09-14).
  it("puts no status text beside the primary", () => {
    render(
      <SetupAssistant
        illustration={<span />}
        title="T"
        dots={dots}
        primary={{ label: "Set Up", onClick: () => {}, disabled: true }}
      />,
    );
    expect(screen.queryByText(/Installing|Waiting for/)).toBeNull();
  });
});
