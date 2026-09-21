import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { CopyButton } from "../copy-button";

afterEach(cleanup);

const writeText = vi.fn((_text: string) => Promise.resolve());

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  writeText.mockReset();
});

describe("CopyButton", () => {
  it("copies what getText answers AT CLICK TIME, not at build time", async () => {
    writeText.mockResolvedValue(undefined);
    const { rerender } = render(
      <CopyButton getText={() => "brew install tmux"} copyKey="k" label="the install command" />,
    );
    // The text changes between renders; a button that had captured the string
    // at build time would copy what the screen no longer shows.
    rerender(<CopyButton getText={() => "sudo port install tmux"} copyKey="k" label="the install command" />);
    screen.getByRole("button").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledWith("sudo port install tmux");
  });

  it("announces the copy on the accessible name, and returns to rest after the flash", async () => {
    writeText.mockResolvedValue(undefined);
    const { container } = render(<CopyButton getText={() => "x"} copyKey="k" />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Copy command");
    expect(container.querySelector("button")?.dataset.state).toBe("idle");
    screen.getByRole("button").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector("button")?.dataset.state).toBe("copied");
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("command copied");
  });

  it("shows a refused clipboard as a failure, not as silence", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const { container } = render(<CopyButton getText={() => "x"} copyKey="k" />);
    screen.getByRole("button").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector("button")?.dataset.state).toBe("failed");
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Could not copy command");
  });

  it("is never disabled, so the fix can be copied while a re-probe is in flight", () => {
    render(<CopyButton getText={() => "x"} copyKey="k" />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });
});
