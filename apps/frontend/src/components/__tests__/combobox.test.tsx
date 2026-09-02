import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ComboboxOption, SearchableSelect } from "@/components/ui/combobox";

const OPTIONS: ComboboxOption[] = [
  { value: "a", label: "Alpha · linux/x64" },
  { value: "b", label: "Beta · darwin/arm64", disabled: true, reason: "no pi here" },
];

afterEach(cleanup);

describe("SearchableSelect", () => {
  it("renders a searchable combobox carrying the caller's id and placeholder", () => {
    render(
      <SearchableSelect
        id="picker-node"
        value=""
        onValueChange={() => {}}
        placeholder="Choose a node"
        options={OPTIONS}
      />,
    );
    const input = screen.getByPlaceholderText("Choose a node");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("id")).toBe("picker-node");
  });

  it("shows the selected option's label as the input value", () => {
    render(<SearchableSelect id="x" value="a" onValueChange={() => {}} placeholder="p" options={OPTIONS} />);
    expect((screen.getByPlaceholderText("p") as HTMLInputElement).value).toBe("Alpha · linux/x64");
  });

  it("opens the popup listing enabled and disabled rows with their reasons; the disabled row is inert", async () => {
    const picked: string[] = [];
    render(
      <SearchableSelect
        id="picker-node"
        value=""
        onValueChange={(v: string) => picked.push(v)}
        placeholder="Choose a node"
        options={OPTIONS}
      />,
    );
    const input = screen.getByPlaceholderText("Choose a node") as HTMLInputElement;
    fireEvent.mouseDown(input);
    fireEvent.click(input);

    const alpha = await screen.findByRole("option", { name: /Alpha · linux\/x64/ });
    const beta = await screen.findByRole("option", { name: /Beta · darwin\/arm64/ });
    // Disabled rows stay listed and explain themselves (greying out explains,
    // never hides) — and carry the data-disabled marker Base UI styles on.
    expect(beta.textContent).toContain("no pi here");
    expect(beta.getAttribute("data-disabled")).toBe("");

    fireEvent.click(beta);
    expect(picked).toEqual([]); // inert: a disabled row never fires onValueChange
    fireEvent.click(alpha);
    expect(picked).toEqual(["a"]);
  });
});
