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

/** A stack the picker may offer (spec 2026-09-29): two live members. */
const stackRow = {
  id: "st1",
  label: "Morning set",
  shared: false,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
  items: [
    { id: "i1", promptId: "pr1", description: "Kickoff", body: "start the task now" },
    { id: "i2", description: "Note", body: "inline text" },
  ],
};
const emptyStack = { ...stackRow, id: "st-empty", label: "Emptied out", items: [] };

/** The stacks default to NONE so the older empty-state sentences keep their
 *  meaning; the stack cases below pass rows explicitly (spec 2026-09-29). */
function mockFetch(
  own: unknown[] = [ownRow],
  shared: unknown[] = [sharedRow],
  ownStacks: unknown[] = [],
  sharedStacks: unknown[] = [],
) {
  const realFetch = globalThis.fetch;
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/prompts/stacks") {
      return Promise.resolve(new Response(JSON.stringify({ own: ownStacks, shared: sharedStacks })));
    }
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

function renderPicker(props: {
  onPick: (block: PromptBlock) => void;
  onExit?: () => void;
  mode?: "multi" | "single";
  allowStacks?: boolean;
  draftScope?: string;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PromptPickerBody
        surface="inline"
        mode={props.mode ?? "multi"}
        allowStacks={props.allowStacks ?? true}
        draftScope={props.draftScope}
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

beforeEach(() => {
  sessionStorage.clear();
  // The "Recently used" list lives in localStorage; clear it so a pick in one
  // case cannot surface as a recent in the next (and seed it explicitly where a
  // case wants recents).
  localStorage.clear();
});
afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
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

  it("the draft is scoped per SURFACE: a launch-form scratch cannot hijack the stack editor's step", async () => {
    restore = mockFetch().restore;
    // Type an unfinished line in the launch form's step (no scope) and walk away.
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    fireEvent.change(screen.getByPlaceholderText("The text to type into the pane"), {
      target: { value: "launch-form scratch" },
    });
    await settle();
    cleanup();
    // The stack editor's step is its OWN front door: no cross-surface revival.
    renderPicker({ onPick: () => {}, draftScope: "stack-editor" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    expect((screen.getByPlaceholderText("The text to type into the pane") as HTMLTextAreaElement).value).toBe("");
    // And the launch form's own surface still resumes what IT left: durability
    // holds WITHIN a scope, it just no longer crosses between them.
    cleanup();
    renderPicker({ onPick: () => {} });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Write your own/ }));
    expect((screen.getByPlaceholderText("The text to type into the pane") as HTMLTextAreaElement).value).toBe(
      "launch-form scratch",
    );
  });

  // Stacks in the listing (spec 2026-09-29): they appear the same as singles,
  // empty ones are never offered, and a pick lands ONE unit block.
  it("a stack rides the listing and its pick is ONE block with the joined text", async () => {
    restore = mockFetch([ownRow], [sharedRow], [stackRow]).restore;
    const picked: PromptBlock[] = [];
    renderPicker({ onPick: (b) => picked.push(b) });
    await settle();
    openSearch();
    await settle();
    fireEvent.click(screen.getByText("Morning set"));
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({
      kind: "stack",
      stackId: "st1",
      stackCount: 2,
      description: "Morning set",
      body: "start the task now\n\ninline text", // members joined, ONE blank line
    });
  });

  it("EMPTY stacks are never offered (nothing to type is a trap, not a row)", async () => {
    restore = mockFetch([ownRow], [sharedRow], [emptyStack]).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    openSearch();
    await settle();
    expect(screen.queryByText("Emptied out")).toBeNull();
    expect(screen.getByText("Kickoff")).toBeTruthy(); // the singles keep their listing
  });

  it("a stack matches the search by member text, like a single matches its body", async () => {
    restore = mockFetch([ownRow], [sharedRow], [stackRow]).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    openSearch();
    await settle();
    const input = document.getElementById("prompt-picker-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "inline text" } });
    await settle();
    expect(screen.getByText("Morning set")).toBeTruthy(); // found through a member
    expect(screen.queryByText("Kickoff")).toBeNull();
  });

  it("allowStacks=false lists singles only (the stack editor never nests)", async () => {
    restore = mockFetch([ownRow], [sharedRow], [stackRow]).restore;
    renderPicker({ onPick: () => {}, allowStacks: false });
    await settle();
    openSearch();
    await settle();
    expect(screen.queryByText("Morning set")).toBeNull();
    expect(screen.getByText("Kickoff")).toBeTruthy();
  });
});

// The "Recently used" memory (operator ruling 2026-09-29): your last picks lead
// the list under one header, then a divider, then the rest, each row ONCE.
describe("PromptPickerBody — Recently used", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  const KEY = "subshell/recent-prompt-picks";

  it("leads with the recently picked rows under one header, each shown once", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { kind: "stack", id: "st1" },
        { kind: "saved", id: "pr1" },
      ]),
    );
    restore = mockFetch(
      [ownRow, { ...ownRow, id: "pr9", description: "Notes", body: "note body" }],
      [],
      [stackRow],
    ).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    openSearch();
    await settle();
    expect(screen.getByText("Recently used")).toBeDefined();
    // The two recents lead, and are NOT repeated in the rest of the list.
    expect(screen.getAllByText("Morning set")).toHaveLength(1);
    expect(screen.getAllByText("Kickoff")).toHaveLength(1);
    // The non-recent row still rides below.
    expect(screen.getByText("Notes")).toBeDefined();
  });

  it("shows no Recently used header on a fresh browser", async () => {
    restore = mockFetch([ownRow], [], [stackRow]).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    openSearch();
    await settle();
    expect(screen.queryByText("Recently used")).toBeNull();
    expect(screen.getByText("Kickoff")).toBeDefined();
  });

  it("caps the Recently used run at three", async () => {
    const four = ["Alpha", "Bravo", "Charlie", "Delta"].map((d, i) => ({
      id: `p${i}`,
      description: d,
      body: d.toLowerCase(),
      shared: false,
      createdAt: "t",
      updatedAt: "t",
    }));
    localStorage.setItem(KEY, JSON.stringify(four.map((r) => ({ kind: "saved" as const, id: r.id }))));
    restore = mockFetch(four, [], []).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    openSearch();
    await settle();
    expect(screen.getByText("Recently used")).toBeDefined();
    // The cap asserted on ORDER, not presence: the recent run is exactly the
    // first three, and Delta is DEMOTED to the rest (still pickable, one row,
    // and no longer a "recent"). Presence alone would pass even with no cap.
    // The label span (first truncate) - the row's textContent also carries
    // the muted reason (the body preview).
    const labels = screen.getAllByRole("option").map((el) => el.querySelector("span.truncate")?.textContent);
    expect(labels.slice(0, 3)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(labels[3]).toBe("Delta");
    expect(labels.filter((t) => t === "Delta")).toHaveLength(1);
  });
});

// The round-5 review: the picker is UNcapped but consumed-posture (value ""),
// and its stacks feed lands AFTER the prompts feed on a cold open - a real
// `items` swap under the user's fingers. An uncontrolled input loses the typed
// text to Base UI's collection reset; the controlled one must not.
describe("PromptPickerBody — a late items swap keeps the typed query", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("typed text survives the stacks payload landing mid-session", async () => {
    const realFetch = globalThis.fetch;
    // Stacks resolve on a PROMISE we control; prompts resolve immediately.
    let releaseStacks: (v: Response) => void = () => {};
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/prompts/stacks") {
        return new Promise<Response>((res) => {
          releaseStacks = res;
        });
      }
      if (url === "/api/prompts" && method !== "POST") {
        return Promise.resolve(new Response(JSON.stringify({ own: [ownRow], shared: [] })));
      }
      return realFetch(input as never, init as never);
    }) as typeof fetch;
    restore = () => (globalThis.fetch = realFetch);

    renderPicker({ onPick: () => {} });
    await settle(); // prompts land; stacks still pending
    openSearch();
    await settle();
    const input = document.getElementById("prompt-picker-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "kick" } });
    await settle();
    expect(input.value).toBe("kick");
    // The stacks payload lands WHILE the text stands: the items array changes
    // identity - the very swap that wiped the uncontrolled field.
    await act(async () => {
      releaseStacks(new Response(JSON.stringify({ own: [stackRow], shared: [] })));
      await settle();
    });
    expect(input.value).toBe("kick");
    // And the search still answers from both feeds.
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });
});

// The round-6 nit: a member whose first line is blank (a custom body may
// start with a newline) must drop its segment, not dangle the separator -
// the launch-defaults rule applied to the stack option's reason line.
describe("PromptPickerBody — stack reason line (no dangling separator)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("a first-line-empty member yields '1 prompt', not '1 prompt · '", async () => {
    const newlineStack = {
      ...stackRow,
      items: [{ id: "i1", description: "Lead", body: "\nsecond line only" }],
    };
    restore = mockFetch([ownRow], [], [newlineStack]).restore;
    renderPicker({ onPick: () => {} });
    await settle();
    openSearch();
    await settle();
    const opt = screen.getByRole("option", { name: /Morning set/ });
    const reason = opt.querySelector("span:last-child")?.textContent ?? "";
    expect(reason).toBe("1 prompt");
    expect(reason).not.toContain(" · ");
  });
});
