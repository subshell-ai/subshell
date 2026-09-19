/**
 * The footer row a BROWSER gets (operator's request, 2026-09-18).
 *
 * The rail had no version line at all, which read as a missing feature and was
 * really a missing ROW: `DesktopAppUpdateRow` reports the app BUNDLE's version
 * over IPC, and a browser is inside no app. The server's own version is a
 * different fact and is not privileged — `GET /api/settings/public` hands
 * `serverVersion` to every signed-in caller.
 *
 * What these pin is the split in audience: everyone reads the version, only an
 * admin gets the dot and the press, because `GET /api/admin/updates` is
 * admin-only and only an admin can act on a server update anyway.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ServerVersionRow } from "@/components/sidebar/server-version-row";

const PUBLIC = { serverVersion: "0.11.1", viewerIsAdmin: false };

function mockFetch(opts: { admin?: boolean; updateTo?: string | null } = {}) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    calls.push(path);
    if (path === "/api/settings/public") {
      return Promise.resolve(new Response(JSON.stringify({ ...PUBLIC, viewerIsAdmin: opts.admin === true })));
    }
    if (path === "/api/admin/updates") {
      const to = opts.updateTo ?? null;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            server: {
              current: PUBLIC.serverVersion,
              updateAvailable: to !== null,
              latest: to === null ? null : { version: to, tag: `cli-server-v${to}` },
            },
          }),
        ),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function renderRow(collapsed = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ServerVersionRow collapsed={collapsed} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("ServerVersionRow", () => {
  it("names the SERVER's version to any signed-in viewer", async () => {
    const fake = mockFetch();
    try {
      renderRow();
      await waitFor(() => expect(screen.getByText(/Subshell Server 0\.11\.1/)).toBeTruthy());
    } finally {
      fake.restore();
    }
  });

  it("gives a member no dot and nothing to press, rather than a control that refuses", async () => {
    const fake = mockFetch({ admin: false, updateTo: "0.12.0" });
    try {
      const { container } = renderRow();
      await waitFor(() => expect(screen.getByText(/Subshell Server 0\.11\.1/)).toBeTruthy());
      expect(screen.queryByRole("button")).toBeNull();
      // The slot is always in the layout for alignment; "no news" is the slot
      // being `invisible`. Asserting `.bg-warning` here would now pass
      // vacuously — that class no longer exists anywhere.
      expect(container.querySelector("span[aria-hidden]")?.className).toContain("invisible");
      // The admin read is never even attempted — a non-admin mount firing a
      // doomed 403 is the gate `/settings/status` established.
      expect(fake.calls).not.toContain("/api/admin/updates");
    } finally {
      fake.restore();
    }
  });

  it("gives an admin the upgrade icon and a door to the Updates page", async () => {
    const fake = mockFetch({ admin: true, updateTo: "0.12.0" });
    try {
      const { container } = renderRow();
      await waitFor(() => expect(screen.getByRole("button", { name: /Open updates/ })).toBeTruthy());
      // The newer version is NOT in the visible line since 2026-09-19 — the
      // sidebar truncated it to an ellipsis — so it is asserted on the
      // accessible name below, and the icon carries it on screen.
      expect(screen.queryByText(/available/)).toBeNull();
      expect(container.querySelector("span[aria-hidden]")?.className).not.toContain("invisible");
      expect(container.querySelectorAll(".text-warning")).toHaveLength(1);
      expect(screen.getByRole("button", { name: /v0\.12\.0 available/ })).toBeTruthy();
    } finally {
      fake.restore();
    }
  });

  it("gives an admin with nothing published the line and no dot", async () => {
    const fake = mockFetch({ admin: true, updateTo: null });
    try {
      const { container } = renderRow();
      await waitFor(() => expect(screen.getByText(/Subshell Server 0\.11\.1/)).toBeTruthy());
      // The slot is always in the layout for alignment; "no news" is the slot
      // being `invisible`. Asserting `.bg-warning` here would now pass
      // vacuously — that class no longer exists anywhere.
      expect(container.querySelector("span[aria-hidden]")?.className).toContain("invisible");
      expect(screen.queryByText(/available/)).toBeNull();
      // Still a door: "no update known" is not "up to date", and the Updates
      // page is where an admin finds out.
      expect(screen.getByRole("button", { name: /Open updates/ })).toBeTruthy();
    } finally {
      fake.restore();
    }
  });

  it("renders nothing until the settings read lands", () => {
    const fake = mockFetch();
    try {
      // No `await`: a row that printed "Subshell Server" with no number would
      // flicker into correctness.
      const { container } = renderRow();
      expect(container.textContent).toBe("");
    } finally {
      fake.restore();
    }
  });

  it("collapses to nothing when there is no news to show", async () => {
    const fake = mockFetch({ admin: true, updateTo: null });
    try {
      const { container } = renderRow(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      // 56px has no room for a version, and a dot with no news is decoration.
      expect(container.textContent).toBe("");
    } finally {
      fake.restore();
    }
  });

  it("collapses to the upgrade icon alone when there IS news", async () => {
    const fake = mockFetch({ admin: true, updateTo: "0.12.0" });
    try {
      const { container } = renderRow(true);
      await waitFor(() => expect(container.querySelectorAll(".text-warning")).toHaveLength(1));
      // The words survive for a screen reader, laid out only as `sr-only`.
      expect(screen.getByRole("button", { name: /v0\.12\.0 available/ })).toBeTruthy();
      expect(container.querySelector(".sr-only")).not.toBeNull();
    } finally {
      fake.restore();
    }
  });
});
