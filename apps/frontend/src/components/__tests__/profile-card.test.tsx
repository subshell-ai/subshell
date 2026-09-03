import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { nameIsUsable, ProfileCard } from "@/components/profile-card";
import * as auth from "@/lib/auth";
import { CURRENT_USER_QUERY_KEY } from "@/lib/query-keys";

/** The Profile card's only rule (spec 2026-09-02 settings-split §1.1): the
 * display name saves trimmed and must not be blank; email is read-only. */
describe("nameIsUsable", () => {
  it("accepts anything non-blank and saves it trimmed", () => {
    expect(nameIsUsable("Thea")).toBe("Thea");
    expect(nameIsUsable("  Thea G  ")).toBe("Thea G");
    expect(nameIsUsable("   ")).toBeNull();
    expect(nameIsUsable("")).toBeNull();
  });
});

const USER = { id: "u1", email: "admin@subshell.test", name: "Old Name" };

describe("ProfileCard", () => {
  // The save path invalidates ["current-user"], whose real queryFn would hit
  // the network. The tests spy getSessionUser; bun test runs every file in
  // ONE process, so the spy MUST be restored — an unrestored module spy
  // leaks into later files (the hazard the suite's mock.module comment warns
  // about; restore is what makes spyOn safe here).
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    cleanup();
  });

  /** Renders the card over a QueryClient primed with ["current-user"] (so the
   * form shows without a fetch) and injects the save mutation — the real
   * better-auth client is a proxy that resists spies, so the card takes it as
   * a prop (NotificationsCard's pattern). `refresh` backs the post-save
   * session refetch (the auth login session, not a subshell) so the cache
   * refresh lands deterministically. */
  function renderCard(
    updateUser: (input: { name: string }) => Promise<{ error?: { message?: string } | null }>,
    refresh: () => Promise<{ id: string; email: string; name: string } | null> = async () => USER,
  ) {
    spies.push(spyOn(auth, "getSessionUser").mockImplementation(refresh));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(CURRENT_USER_QUERY_KEY, USER);
    render(
      <QueryClientProvider client={qc}>
        <ProfileCard updateUser={updateUser} />
      </QueryClientProvider>,
    );
  }

  it("saves the trimmed name and leaves the input showing exactly what was saved", async () => {
    const saved: string[] = [];
    renderCard(
      async ({ name }) => {
        saved.push(name);
        return { error: null };
      },
      async () => ({ ...USER, name: "Thea G" }),
    );
    const input = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(input.value).toBe("Old Name");
    fireEvent.change(input, { target: { value: "  Thea G  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saved).toEqual(["Thea G"]));
    // The fix (settings-split review): the draft is set to the trimmed saved
    // name on success — shown == saved, the field must not keep the padding.
    await waitFor(() => expect(input.value).toBe("Thea G"));
    expect(await screen.findByText("saved")).toBeDefined();
  });

  it("keeps the draft and reports the error when the save fails", async () => {
    renderCard(async () => ({ error: { message: "Server said no" } }));
    const input = (await screen.findByLabelText("Name")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Thea G  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Server said no")).toBeDefined();
    expect(input.value).toBe("  Thea G  "); // untouched — nothing was saved
    expect(screen.queryByText("saved")).toBeNull();
  });
});
