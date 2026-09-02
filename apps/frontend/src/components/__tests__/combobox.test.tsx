import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
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
});
