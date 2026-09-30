import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StackPageRow } from "@/components/prompts/stack-page-row";
import type { OwnStackRow, StackItemRow } from "@/lib/prompt-stacks";

/**
 * The stack row (spec 2026-09-29): the count line over the label, the member
 * list on expand, and the per-member Edit rule (own references edit; foreign
 * ones offer no dead control). The menus are Base UI popups, so the tests
 * read the RENDERED row, and the member Edit path is verified through the
 * callback the menu wires, not a popup hunt.
 */

const mine = (over: Partial<StackItemRow> = {}): StackItemRow => ({
  id: over.id ?? "i1",
  promptId: over.promptId ?? "pr1",
  description: over.description ?? "Kickoff",
  body: over.body ?? "start the task",
});
const foreign = (): StackItemRow => ({
  id: "i2",
  promptId: "pr9",
  description: "Ada's prompt",
  body: "not mine",
  ownerName: "Ada",
});
const inline = (): StackItemRow => ({ id: "i3", description: "Note", body: "inline text" });

const stack = (items: StackItemRow[]): OwnStackRow => ({
  id: "st1",
  label: "Morning set",
  shared: false,
  createdAt: "t",
  updatedAt: "t",
  items,
});

const noop = () => {};
afterEach(cleanup);

function renderRow(items: StackItemRow[], highlight = false) {
  const memberEdits: StackItemRow[] = [];
  const { container } = render(
    <StackPageRow
      stack={stack(items)}
      highlight={highlight}
      items={[]}
      onEditMember={(i) => memberEdits.push(i)}
      canEditMember={(i) => i.promptId !== "pr9"}
    />,
  );
  return { memberEdits, container };
}

describe("StackPageRow", () => {
  it("the collapsed line carries the count and the updated stamp", () => {
    renderRow([mine(), inline()]);
    expect(screen.getByText(/2 prompts · updated/)).toBeTruthy();
    expect(screen.getByText("Morning set")).toBeTruthy();
  });

  /** The expander button by its aria-controls (the menu trigger is also a
   *  button, Base UI keeps its own aria-expanded, so role queries double). */
  function clickExpander(container: HTMLElement) {
    const expander = container.querySelector<HTMLButtonElement>('button[aria-controls="stack-members-st1"]');
    if (!expander) throw new Error("expander button not rendered");
    fireEvent.click(expander);
  }

  it("an empty stack SAYS Empty, and the owner sees the recovery the editor offers", () => {
    const { container } = render(
      <StackPageRow stack={stack([])} items={[]} onEditMember={noop} canEditMember={() => true} />,
    );
    expect(screen.getByText(/Empty · updated/)).toBeTruthy();
    clickExpander(container);
    expect(screen.getByText(/Nothing here/)).toBeTruthy();
    // The owner CAN edit the stack, so the sentence names the remedy.
    expect(screen.getByText(/Edit the stack/)).toBeTruthy();
  });

  it("a reader of a shared stack gets the FACT, not an Edit instruction they lack", () => {
    const { container } = render(
      <StackPageRow stack={stack([])} canEditStack={false} items={[]} onEditMember={noop} canEditMember={() => true} />,
    );
    clickExpander(container);
    expect(screen.getByText(/Nothing here/)).toBeTruthy();
    expect(screen.queryByText(/Edit the stack/)).toBeNull();
  });

  it("expansion lists members in order, numbered, inline and foreign rows included", () => {
    const { container } = render(
      <StackPageRow
        stack={stack([mine(), inline(), foreign()])}
        items={[]}
        onEditMember={noop}
        canEditMember={() => true}
      />,
    );
    clickExpander(container);
    expect(screen.getByText("1. Kickoff")).toBeTruthy();
    expect(screen.getByText("2. Note")).toBeTruthy();
    expect(screen.getByText("3. Ada's prompt")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy(); // foreign member carries its owner badge
  });

  it("own references offer a working member Edit; foreign ones offer no dead control", async () => {
    // The predicate gates the MENU ITSELF (canEditMember false renders no
    // trigger), so the foreign row's absence is the rule, and the own row's
    // Edit must actually fire onEditMember with its item.
    const { memberEdits, container } = renderRow([mine(), foreign()]);
    clickExpander(container);
    expect(screen.queryByRole("button", { name: "Actions for Ada's prompt" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Actions for Kickoff" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(memberEdits.map((i) => i.id)).toEqual(["i1"]);
  });

  it("the arrival ring is a prop, not a lingering state", () => {
    const { container } = render(
      <StackPageRow stack={stack([mine()])} highlight items={[]} onEditMember={noop} canEditMember={() => true} />,
    );
    expect(container.querySelector('[data-stack-id="st1"]')?.className).toContain("ring-1");
  });
});
