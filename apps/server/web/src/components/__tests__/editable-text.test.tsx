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

  it("maxChars enforces a character-counting rule under a unit-counting ceiling", async () => {
    // Node names arrived at this by being capped twice over. `normalizeNodeName`
    // caps CHARACTERS; a DOM `maxlength` counts UTF-16 units, so the rename field
    // has to carry both numbers — 128 units of ceiling, 64 characters of rule. An
    // emoji name at the character cap is 128 units and must still save; a name one
    // character past it must be refused here, in the field, with the number the rule
    // speaks rather than the number the input happens to count.
    const saved: string[] = [];
    render(
      <EditableText
        value="deck"
        label="Rename node"
        onSave={async (v) => {
          saved.push(v);
        }}
        maxLength={128}
        maxChars={64}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename node" }));
    const input = screen.getByRole("textbox", { name: "Rename node" });

    const widest = "\u{1F5A5}".repeat(64); // 64 characters, 128 units
    fireEvent.change(input, { target: { value: widest } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(saved).toEqual([widest]));

    // A saved commit closes the field, so the second half needs it opened again —
    // firing on the detached node would test nothing and pass by accident.
    fireEvent.click(screen.getByRole("button", { name: "Rename node" }));
    const again = screen.getByRole("textbox", { name: "Rename node" });
    fireEvent.change(again, { target: { value: "a".repeat(65) } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(await screen.findByText("Keep it under 64 characters")).toBeDefined();
    expect(saved).toEqual([widest]);
  });

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

  it("a blank draft stays open and says why instead of silently reverting", async () => {
    const saved: string[] = [];
    const input = renderLine(async (v) => void saved.push(v));
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("A name is required")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Rename workspace" })).toBeDefined();
    // Typing a valid value and Enter clears the error and saves.
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(saved).toEqual(["New"]));
  });

  it("an unchanged draft reverts silently", async () => {
    const saved: string[] = [];
    const input = renderLine(async (v) => void saved.push(v));
    fireEvent.change(input, { target: { value: "Deck" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(saved).toEqual([]);
  });

  it("an over-length draft is rejected without calling onSave; maxLength caps the input", async () => {
    const saved: string[] = [];
    render(<EditableText value="Deck" label="Rename" onSave={async (v) => void saved.push(v)} maxLength={10} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename" });
    expect((input as HTMLInputElement).maxLength).toBe(10);
    // fireEvent bypasses the DOM maxlength, so the component guard is exercised too:
    fireEvent.change(input, { target: { value: "x".repeat(11) } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Keep it under 10 characters")).toBeDefined();
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
