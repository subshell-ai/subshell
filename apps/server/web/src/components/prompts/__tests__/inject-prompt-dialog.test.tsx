import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { InjectPromptDialog } from "@/components/prompts/inject-prompt-dialog";

/**
 * The menu's inject path (spec 2026-09-28), pinned at the exact shape the
 * round-5 review found broken: the menu unmounts this component when the
 * close reaches it, so the picker's pick-close must be ABSORBED here (the
 * confirm step renders), and only a non-pick close may reach the owner.
 * The confirm's send is typed-not-submitted: `submit: false`, the server's
 * own ruling.
 */

function Harness({ onClosed }: { onClosed: (v: boolean) => void }) {
  // The menu's real posture: mount-while-open, close unmounts.
  const [open, setOpen] = useState(true);
  return (
    <InjectPromptDialog
      subshellId="s1"
      subshellName="Pane"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onClosed(next);
      }}
    />
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

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

afterEach(() => cleanup());

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
    fireEvent.click(screen.getByText("Kickoff"));
    await settle();
    // The pick-close never reached the owner (that would unmount the
    // subtree and discard the pick — the round-5 critical), and the
    // confirm step named the prompt and the pane.
    expect(closes).toEqual([]);
    expect(screen.getByText(/Inject "Kickoff" into "Pane"/)).toBeDefined();
  });

  it("Type into pane sends typed-not-submitted and then closes", async () => {
    const m = mockFetch();
    restore = m.restore;
    const { closes } = renderDialog();
    await settle();
    fireEvent.click(screen.getByText("Kickoff"));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Type into pane" }));
    await waitFor(() => expect(m.inputPosts.length).toBe(1));
    expect(m.inputPosts[0]).toEqual({ text: "start the task", submit: false });
    await waitFor(() => expect(closes).toEqual([false]));
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
