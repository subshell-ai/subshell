import { afterEach, describe, expect, it } from "bun:test";
import type { Node } from "@internal/node-admin";
import { cleanup, render, screen } from "@testing-library/react";
import { VirtualDisplayField, virtualDisplayReason } from "@/components/subshell-picker/virtual-display-field";

afterEach(cleanup);
const linux = { id: "node1", os: "linux", previewEnabled: true, canManage: true } as Node;

describe("virtual display prerequisites", () => {
  it("requires Linux and an enabled preview setting", () => {
    expect(virtualDisplayReason(linux)).toBeUndefined();
    expect(virtualDisplayReason({ ...linux, os: "darwin" })).toContain("Linux");
    expect(virtualDisplayReason({ ...linux, previewEnabled: false })).toContain("Allow preview");
    expect(virtualDisplayReason(null)).toContain("Choose a machine");
  });

  it("drops a checked display when the selected machine stops supporting it", () => {
    const changes: boolean[] = [];
    const props = { id: "display", checked: true, onChange: (checked: boolean) => changes.push(checked) };
    const view = render(<VirtualDisplayField {...props} node={linux} />);
    expect(changes).toEqual([]);
    view.rerender(<VirtualDisplayField {...props} node={{ ...linux, os: "darwin" }} />);
    expect(changes).toEqual([false]);
    expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/Linux machines only/)).toBeTruthy();
  });
});
