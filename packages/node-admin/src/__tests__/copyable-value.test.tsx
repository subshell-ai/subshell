import { afterEach, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CopyableValue } from "../ui/copyable-value";

const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
afterEach(() => {
  cleanup();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (execCommand) Object.defineProperty(document, "execCommand", execCommand);
  else Reflect.deleteProperty(document, "execCommand");
});

for (const origin of ["http://10.1.10.50:3080", "https://subshell.shred.heavymetal.network"]) {
  it(`copies the complete callback URI for ${origin}`, async () => {
    const value = `${origin}/api/auth/callback/google`;
    const writeText = mock(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<CopyableValue value={value} label="Redirect URI" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy redirect uri" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Redirect URI copied" })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(value);
  });
}

it("copies the full URI without Clipboard API on HTTP and restores focus", async () => {
  const value = "http://10.1.10.50:3080/api/auth/callback/google";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const copy = mock((command: string) => {
    expect(command).toBe("copy");
    expect((document.activeElement as HTMLTextAreaElement).value).toBe(value);
    return true;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: copy });
  render(<CopyableValue value={value} label="Redirect URI" />);
  const button = screen.getByRole("button", { name: "Copy redirect uri" });
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute("aria-label")).toBe("Redirect URI copied"));
  expect(document.activeElement).toBe(button);
  expect(document.querySelector("textarea")).toBeNull();
});

it("reports failure when both clipboard methods are blocked", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        throw new Error("Denied");
      },
    },
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  render(<CopyableValue value="http://example.test/api/auth/callback/google" label="Redirect URI" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy redirect uri" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not copy"));
  expect(screen.queryByRole("button", { name: "Redirect URI copied" })).toBeNull();
  expect(document.querySelector("textarea")).toBeNull();
});
