import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { DisplayScreen } from "@/components/assistant/display-screen";
import { installFakeIpc, renderApp } from "./harness";

// One document per bun test process: a render left mounted is DOM the next
// file in the shard reads as its own (`harness.tsx`).
afterEach(cleanup);

const shell = {
  title: "Virtual Displays",
  subtitle: "A virtual display gives a subshell a screen for graphical apps without needing another physical monitor.",
};

describe("the Virtual Displays screen", () => {
  /**
   * The wire name, pinned where it is pressed. `node_open_display_helper`
   * lives in three files (this call, `permissions/desktop.toml`,
   * `capabilities/node.json`) and a rename in one of them is a runtime
   * permission refusal in the window rather than a compile error.
   */
  it("opens the native helper panel on the one press", () => {
    const fake = installFakeIpc({ handlers: { node_open_display_helper: () => null } });
    try {
      renderApp(<DisplayScreen shell={shell} />);
      fireEvent.click(screen.getByRole("button", { name: "Open Display Helper settings" }));
      expect(fake.callsTo("node_open_display_helper")).toHaveLength(1);
    } finally {
      fake.restore();
    }
  });

  /**
   * A refusal arrives from macOS (no helper shipped in this bundle, say) and
   * Rust answers it in a native dialog, so this screen has no message of its
   * own. What a later edit could break is the screen itself: a rejection that
   * unwound through the click handler would leave a blank window on the one
   * platform where the screen exists.
   */
  it("keeps its instructions when the panel cannot be opened", () => {
    const fake = installFakeIpc({
      handlers: {
        node_open_display_helper: () => {
          throw new Error("display helper is not bundled");
        },
      },
    });
    try {
      renderApp(<DisplayScreen shell={shell} />);
      fireEvent.click(screen.getByRole("button", { name: "Open Display Helper settings" }));
      expect(screen.getByRole("button", { name: "Open Display Helper settings" })).toBeTruthy();
      // All three steps are still there to read.
      expect(screen.getAllByRole("listitem")).toHaveLength(3);
    } finally {
      fake.restore();
    }
  });

  /**
   * The steps must survive as an ORDERED list, not a paragraph. They are the
   * reason the screen exists: the menu bar item opened a panel and said
   * nothing about the two macOS permissions it would then ask for.
   */
  it("puts the instructions in order, so the reader can tell which step is next", () => {
    const fake = installFakeIpc({ handlers: { node_open_display_helper: () => null } });
    try {
      renderApp(<DisplayScreen shell={shell} />);
      const steps = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
      expect(steps.some((s) => s.includes("Screen Recording"))).toBe(true);
      // Enabling comes before granting, because the helper has to be running
      // before macOS has anything to ask about.
      expect(steps[0]).toContain("Enable helper");
    } finally {
      fake.restore();
    }
  });

  /**
   * The guide's word, pinned where it is pressed. `wire-names.test.ts` holds
   * the TS union and Rust's enum equal, but only this call carries the fact
   * that THIS screen sends that member: a drifted string is a runtime refusal
   * no type check sees.
   */
  it("names the display guide, so the system browser opens the enablement page", () => {
    const fake = installFakeIpc({ handlers: { node_open_display_helper: () => null, node_open_web: () => null } });
    try {
      renderApp(<DisplayScreen shell={shell} />);
      fireEvent.click(screen.getByRole("button", { name: "How to enable the display helper" }));
      expect(fake.callsTo("node_open_web")).toEqual([{ target: "display-guide" }]);
    } finally {
      fake.restore();
    }
  });
});
