import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { InjectPromptDialog } from "@/components/prompts/inject-prompt-dialog";

/**
 * The menu's inject path (spec 2026-09-28), pinned at the shape the
 * round-5 review found broken and the inline rebuild (2026-09-29) keeps:
 * the menu unmounts this component when a close reaches it, so a PICK
 * must never close anything - it advances by the unmount swap from the
 * picker body to the confirm step, and only a real dismissal (Done,
 * Escape, a successful send) reaches the owner. The confirm's send is
 * typed-not-submitted: `submit: false`, the server's own ruling.
 */

function Harness({ onClosed }: { onClosed: (v: boolean) => void }) {
  // The menu's real posture (subshell-actions-menu.tsx:298): mount-while-
  // open, close UNMOUNTS, so a close that reaches here really does discard
  // the subtree's state.
  const [open, setOpen] = useState(true);
  return (
    <>
      {open && (
        <InjectPromptDialog
          subshellId="s1"
          subshellName="Pane"
          open
          onOpenChange={(next) => {
            setOpen(next);
            onClosed(next);
          }}
        />
      )}
    </>
  );
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const closes: boolean[] = [];
  render(
    <QueryClientProvider client={client}>
      <Harness onClosed={(v) => closes.push(v)} />
    </QueryClientProvider>,
  );
  return { closes };
}

/** The combobox popup opens on a real pointer gesture, not a bare click
 *  (happy-dom); every row pick below is preceded by this. */
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

// Picks in this suite write the picker's "Recently used" memory
// (localStorage, process-wide): clear the PREcondition too, or a lib suite
// sharing the bun test process reads these picks as pollution (round-4).
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  cleanup();
});

describe("InjectPromptDialog", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  function mockFetch() {
    const realFetch = globalThis.fetch;
    const inputPosts: Record<string, unknown>[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      // The picker now reads stacks too (spec 2026-09-29); this suite is
      // about singles, so none are offered (empty is a valid answer, not an
      // error, and keeps the fetch deterministic).
      if (url === "/api/prompts/stacks") {
        return Promise.resolve(new Response(JSON.stringify({ own: [], shared: [] })));
      }
      if (url === "/api/prompts" && method !== "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              own: [
                {
                  id: "pr1",
                  description: "Kickoff",
                  body: "start the task",
                  shared: false,
                  createdAt: "t",
                  updatedAt: "t",
                },
              ],
              shared: [],
            }),
          ),
        );
      }
      if (url === "/api/subshells/s1/input") {
        inputPosts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      return realFetch(input as never, init as never);
    }) as typeof fetch;
    return { inputPosts, restore: () => (globalThis.fetch = realFetch) };
  }

  it("a pick ADVANCES to the confirm instead of unmounting the flow", async () => {
    const m = mockFetch();
    restore = m.restore;
    const { closes } = renderDialog();
    await settle();
    openSearch();
    await settle();
    fireEvent.click(screen.getByText("Kickoff"));
    await settle();
    // No close reached the owner (the round-5 critical: one would
    // unmount the subtree and discard the pick), and the confirm step
    // named the prompt and the pane.
    expect(closes).toEqual([]);
    expect(screen.getByText(/Inject "Kickoff" into "Pane"/)).toBeDefined();
  });

  it("Type into pane sends typed-not-submitted and then closes", async () => {
    const m = mockFetch();
    restore = m.restore;
    const { closes } = renderDialog();
    await settle();
    openSearch();
    await settle();
    fireEvent.click(screen.getByText("Kickoff"));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Type into pane" }));
    await waitFor(() => expect(m.inputPosts.length).toBe(1));
    expect(m.inputPosts[0]).toEqual({ text: "start the task", submit: false });
    await waitFor(() => expect(closes).toEqual([false]));
  });

  it("after a pick and Back, the NEXT Done still reaches the owner", async () => {
    // Pins the ADVANCE-leaves-no-lingering-state rule: after a pick and
    // Back, the picker is live again and its Done must reach the owner.
    const m = mockFetch();
    restore = m.restore;
    const { closes } = renderDialog();
    await settle();
    openSearch();
    await settle();
    fireEvent.click(screen.getByText("Kickoff"));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(closes).toEqual([false]);
  });

  it("a non-pick close (Done) reaches the owner and ends the flow", async () => {
    const m = mockFetch();
    restore = m.restore;
    const { closes } = renderDialog();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(closes).toEqual([false]);
  });
});
