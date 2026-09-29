import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PromptPickerBody } from "@/components/prompts/prompt-picker-body";
import type { PromptBlock } from "@/lib/prompt-stack";

/**
 * The shared picker BODY (spec 2026-09-28), the component the launch form
 * renders inline and the inject action puts on a Dialog (ruling 2026-09-29
 * after dialog-on-dialog proved unwieldy). The list is the searchable
 * combobox, whose Base UI popup opens on a real POINTER gesture, not a bare
 * click (happy-dom quirk pinned below in openSearch) so the tests lead with
 * pointer/mouse events the way the operator's mouse does. The BODY reports
 * picks and exits and closes nothing itself (the surfaces pin what leaving
 * means); the custom draft survives a reload until submitted.
 */

const ownRow = {
  id: "pr1",
  description: "Kickoff",
  body: "start the task now",
  shared: false,
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
};
const sharedRow = {
  id: "pr2",
  description: "Review",
  body: "check the diff",
  shared: true,
  ownerName: "Ada",
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
};

function mockFetch(own: unknown[] = [ownRow], shared: unknown[] = [sharedRow]) {
  const realFetch = globalThis.fetch;
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/prompts" && method !== "POST") {
      return Promise.resolve(new Response(JSON.stringify({ own, shared })));
    }
    if (url === "/api/prompts" && method === "POST") {
      posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Promise.resolve(new Response(JSON.stringify(ownRow)));
    }
    return realFetch(input as never, init as never);
  }) as typeof fetch;
  return { posts, restore: () => (globalThis.fetch = realFetch) };
}

function renderPicker(props: { onPick: (block: PromptBlock) => void; onExit?: () => void; mode?: "multi" | "single" }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PromptPickerBody
        surface="inline"
        mode={props.mode ?? "multi"}
        onExit={props.onExit ?? (() => {})}
        onPick={props.onPick}
      />
    </QueryClientProvider>,
  );
}

/** The combobox popup opens on a real pointer gesture; a bare click does
 *  not reach Base UI's trigger in happy-dom. */
function openSearch(): void {
  const input = document.getElementById("prompt-picker-search");
  if (!input) return;
  // Inside act(): Base UI updates on the pointer events, and the bare
  // dispatch floods "not wrapped in act" noise (the ffe50bc rule).
  act(() => {
    for (const type of ["pointerdown", "pointerup"]) {
      input.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse" }));
    }
    for (const type of ["mousedown", "mouseup", "click"]) {
      input.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  });
}

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  sessionStorage.clear();
  cleanup();
});

describe("PromptPickerBody", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("picking a row reports ONE pick and nothing else (surfaces decide)", async () => {
    restore = mockFetch().restore;
    const picked: PromptBlock[] = [];
    let exits = 0;
    renderPicker({ onPick: (b) => picked.push(b), onExit: () => exits++ });
    await settle();
    openSearch();
    await settle();
    fireEvent.click(screen.getByText("Kickoff"));
    expect(picked.map((b) => [b.kind, b.promptId, b.description])).toEqual([["saved", "pr1", "Kickoff"]]);
    expect(exits).toBe(0);
  });

  it("Cancel exits on BOTH steps (multi speaks the form, not the dialog)", async () => {
    restore = mockFetch().restore;
    let exits = 0;
    renderPicker({ onPick: () => {}, onExit: () => exits++ });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(exits).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(exits).toBe(2);
  });

  it("search matches the body, not just the label", async () => {
    // Two OWN rows, and only the second's BODY carries "verify": the label
    // filter alone could not find it, which is the whole point.
    restore = mockFetch([ownRow, { ...ownRow, id: "pr9", description: "Notes", body: "please verify notes" }]).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    openSearch();
    await settle();
    const input = document.getElementById("prompt-picker-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "verify" } });
    await settle();
    expect(screen.queryByText("Kickoff")).toBeNull();
    expect(screen.getByText("Notes")).toBeDefined();
    fireEvent.change(input, { target: { value: "task" } });
    await settle();
    expect(screen.getByText("Kickoff")).toBeDefined();
  });

  it("the shared tab answers its own question when empty", async () => {
    restore = mockFetch([ownRow], []).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    await settle();
    openSearch();
    await settle();
    expect(screen.queryByText("Kickoff")).toBeNull();
    // Regex, not exact: Base UI's Empty node carries a word-joiner
    // (U+2060) that defeats the exact string matcher.
    expect(screen.getByText(/No shared prompts yet/)).toBeDefined();
  });

  const addStackButton = () => screen.getByRole("button", { name: "Add prompt" }) as HTMLButtonElement;

  it("the step's submit is DISABLED until its requirements are filled (gating sweep 2026-09-29)", async () => {
    restore = mockFetch([], []).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    // Pristine: the body is empty, so the button is born dead — and quiet
    // (no red sentence on a field nobody touched).
    expect(addStackButton().disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("The text to type into the pane"), {
      target: { value: "do the thing" },
    });
    expect(addStackButton().disabled).toBe(false);
  });

  it("Write your own saves only with the switch on, and needs a description then", async () => {
    const m = mockFetch([], []);
    restore = m.restore;
    const picked: PromptBlock[] = [];
    renderPicker({ onPick: (b) => picked.push(b) });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    fireEvent.change(screen.getByPlaceholderText("The text to type into the pane"), {
      target: { value: "do the thing" },
    });
    // No switch: a one-off, nothing hits the library.
    fireEvent.click(addStackButton());
    await waitFor(() => expect(picked.length).toBe(1)); // handleSubmit is async
    expect(picked[0].kind).toBe("custom");
    expect(m.posts.length).toBe(0);
  });

  it("with the save switch on a description is required: the gate closes BEFORE any click", async () => {
    const m = mockFetch([], []);
    restore = m.restore;
    const picked: PromptBlock[] = [];
    renderPicker({ onPick: (b) => picked.push(b) });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    fireEvent.change(screen.getByPlaceholderText("The text to type into the pane"), {
      target: { value: "do the thing" },
    });
    expect(addStackButton().disabled).toBe(false);
    // getByLabelText misses the Base UI switch under happy-dom; the role is
    // unique here. Flipping it makes the empty description required — the
    // gate closes on the SWITCH, not on a click.
    fireEvent.click(screen.getByRole("switch"));
    expect(addStackButton().disabled).toBe(true);
    // The sentence explains once the field has been touched (blur), not
    // before: the disabled button never has to throw away its press.
    const desc = screen.getByLabelText("Prompt description") as HTMLInputElement;
    fireEvent.change(desc, { target: { value: " " } });
    fireEvent.blur(desc);
    expect(screen.getByRole("alert").textContent).toContain("short description");
    fireEvent.click(addStackButton()); // disabled: inert even if reached
    expect(picked.length).toBe(0);
    fireEvent.change(desc, { target: { value: "The thing" } });
    expect(addStackButton().disabled).toBe(false);
    fireEvent.click(addStackButton());
    await waitFor(() => expect(m.posts.length).toBe(1));
    expect(m.posts[0].body).toEqual({ description: "The thing", body: "do the thing", shared: false });
    await waitFor(() => expect(picked.length).toBe(1));
    expect(picked[0].description).toBe("The thing");
  });

  it("the save switch is OFF on every entry, draft or not", async () => {
    // Operator ruling 2026-09-29: "save to my prompts" is never restored
    // ON from a draft; a prompt used once has not earned a row, and the
    // person re-declares that every time.
    restore = mockFetch([], []).restore;
    sessionStorage.setItem(
      "subshell/prompt-picker-draft/multi",
      JSON.stringify({ body: "kept text", description: "kept label", saveToLibrary: true }),
    );
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    expect((screen.getByRole("switch") as HTMLElement).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByPlaceholderText("The text to type into the pane") as HTMLTextAreaElement).value).toBe(
      "kept text",
    );
  });

  it("a bare visit to the step saves NO draft (no reopen hijack)", async () => {
    // The round-8 MEDIUM pin: curiosity click on "Write your own...",
    // close without typing; the NEXT open must be the list, not an empty
    // editor the person has to step back out of every time.
    restore = mockFetch([], []).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    await settle();
    cleanup();
    renderPicker({ onPick: () => {} });
    await settle();
    expect(screen.getByRole("button", { name: /Write your own/ })).toBeDefined();
  });

  it("the custom draft SURVIVES a reload and is spent on submit", async () => {
    const m = mockFetch([], []);
    restore = m.restore;
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    fireEvent.change(screen.getByPlaceholderText("The text to type into the pane"), {
      target: { value: "half an idea" },
    });
    await settle();
    cleanup();

    // The page came back: the picker opens at the LIST (the front door),
    // and the draft waits in storage for whoever enters the step.
    const picked: PromptBlock[] = [];
    renderPicker({ onPick: (b) => picked.push(b) });
    await settle();
    expect(screen.queryByPlaceholderText("The text to type into the pane")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    expect((screen.getByPlaceholderText("The text to type into the pane") as HTMLTextAreaElement).value).toBe(
      "half an idea",
    );
    // The seeded draft satisfies the gate: the restored step is submittable.
    expect(addStackButton().disabled).toBe(false);
    fireEvent.click(addStackButton());
    await waitFor(() => expect(picked.length).toBe(1)); // handleSubmit is async

    // Submitted: spent. The step now opens EMPTY, not on the old text.
    cleanup();
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    expect((screen.getByPlaceholderText("The text to type into the pane") as HTMLTextAreaElement).value).toBe("");
  });
});
