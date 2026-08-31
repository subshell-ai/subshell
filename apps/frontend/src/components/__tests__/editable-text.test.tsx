import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditableText } from "@/components/editable-text";

/** Renders one editable line and returns the values it was asked to save. */
function renderLine(onSave: (next: string) => Promise<void>) {
  render(<EditableText value="Deck" label="Rename workspace" onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
  return screen.getByRole("textbox", { name: "Rename workspace" });
}

describe("EditableText", () => {
  afterEach(cleanup);

  it("click opens the value as a draft; Enter saves it trimmed", async () => {
    const saved: string[] = [];
    const input = renderLine(async (v) => void saved.push(v));
    expect((input as HTMLInputElement).value).toBe("Deck");
    fireEvent.change(input, { target: { value: "  Frontend deck  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(saved).toEqual(["Frontend deck"]));
    // A saved line collapses back to text.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("blur saves what typing did not", async () => {
    const saved: string[] = [];
    const input = renderLine(async (v) => void saved.push(v));
    fireEvent.change(input, { target: { value: "Via blur" } });
    fireEvent.blur(input);
    await waitFor(() => expect(saved).toEqual(["Via blur"]));
  });

  it("Escape reverts without saving", async () => {
    const saved: string[] = [];
    const input = renderLine(async (v) => void saved.push(v));
    fireEvent.change(input, { target: { value: "discard me" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(saved).toEqual([]);
    expect(screen.getByRole("button", { name: "Rename workspace" })).toBeDefined();
  });

  it("an empty or unchanged draft reverts instead of saving", async () => {
    const saved: string[] = [];
    const input = renderLine(async (v) => void saved.push(v));
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toBeDefined();
    fireEvent.change(input, { target: { value: "Deck" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(saved).toEqual([]);
  });

  it("a rejected save keeps the draft open with the reason, and blur does not retry", async () => {
    let calls = 0;
    const input = renderLine(() => {
      calls++;
      return Promise.reject(new Error("You already have a workspace with that name"));
    });
    fireEvent.change(input, { target: { value: "Taken" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("You already have a workspace with that name")).toBeDefined();
    // Clicking away must not silently fire the rejected save again.
    fireEvent.blur(input);
    await waitFor(() => expect(calls).toBe(1));
  });
});
