import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { choiceToWire, isDirty, storedToChoice, TerminalHistoryCard } from "@/components/terminal-history-card";

/**
 * The per-USER terminal history cap card (spec 2026-09-03 §2), replacing the
 * per-subshell dialog. Two layers are pinned here:
 *
 * - the value mapping (stored ⇄ draft ⇄ wire ⇄ dirty-gate) as pure logic —
 *   a Base UI Select CAN be driven under happy-dom (see
 *   `switch-preset-dialog.test.tsx`'s click + pointerdown/up/click helpers),
 *   but the mapping is cheaper to pin directly than through the popup;
 * - the card's read/adopt/gate render cycle through injected props (the
 *   master-switch card is the precedent).
 *
 * The wire contract itself (bounds, null, cookie-only) is pinned by
 * `settings-route.test.ts` on the server.
 */

const saveButton = () => screen.getByRole("button", { name: /Saving|Save/ });
const trigger = () => screen.getByRole("combobox");

afterEach(() => cleanup());

describe("terminal-history mapping", () => {
  it("stored ⇄ draft", () => {
    expect(storedToChoice(null)).toBe("default");
    expect(storedToChoice(50)).toBe("50");
  });

  it("draft → wire: the sentinel sends null, numbers pass through", () => {
    expect(choiceToWire("default")).toBeNull();
    expect(choiceToWire("200")).toBe(200);
  });

  it("dirty only when the draft differs from the stored value", () => {
    expect(isDirty(null, "default")).toBe(false);
    expect(isDirty(50, "50")).toBe(false);
    expect(isDirty(50, "150")).toBe(true);
    expect(isDirty(50, "default")).toBe(true);
    expect(isDirty(null, "25")).toBe(true);
  });
});

describe("TerminalHistoryCard", () => {
  it("adopts the stored cap from the server and starts with Save inert", async () => {
    render(<TerminalHistoryCard getLines={async () => 50} setLines={async (l) => l} />);
    await waitFor(() => expect(trigger().textContent).toContain("50"));
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("null reads as the instance default", async () => {
    render(<TerminalHistoryCard getLines={async () => null} setLines={async (l) => l} />);
    await waitFor(() => expect(trigger().textContent).toContain("Instance default"));
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("a failed read still renders, on the safe default", async () => {
    render(
      <TerminalHistoryCard
        getLines={async () => {
          throw new Error("offline");
        }}
        setLines={async (l) => l}
      />,
    );
    await waitFor(() => expect(trigger().textContent).toContain("Instance default"));
  });
});
