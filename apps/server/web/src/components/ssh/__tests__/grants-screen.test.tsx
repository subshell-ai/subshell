import { afterEach, describe, expect, it } from "bun:test";
import { type ConfirmOptions, setConfirmHandler } from "@internal/node-admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GrantsScreen } from "@/components/ssh/grants-screen";

/**
 * The grants screen (spec 2026-10-08 §6.1, §8): the owner's standing key
 * grants, their selected agent identities, the name/selector edit, and the
 * instant-both-ways revoke. The revoke is the screen's one destructive act, so
 * its confirm is pinned: a STATIC title (the ruling 2026-09-30: the name rides
 * the body) and a refusal of the DELETE rendered red on the row that failed.
 * The edit dialog is pinned too: it PATCHes only name and selector, never the
 * fingerprint set the server declares immutable.
 */

const FP_ONE = `SHA256:${"A".repeat(43)}`;
const FP_TWO = `SHA256:${"B".repeat(43)}`;
// Roster fingerprints kept distinct from the standing grant's: the create-flow
// tests assert on these texts while the list rows render FP_ONE/FP_TWO.
const ROSTER_ONE = `SHA256:${"D".repeat(43)}`;

const GRANT = {
  id: "g1",
  name: "prod keys",
  keyHomeNodeId: "nodeA",
  resolvedSelector: "*.prod.example.com",
  fingerprints: [FP_ONE, FP_TWO],
  createdVia: "first-use",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
};

/**
 * The picker's candidates: vault is the one create-eligible key home (agent,
 * SSH on, owner); `plane` is the control host (never a key home), `locked`
 * has SSH off, and `borrowed` is a shared machine (SSH is owner-reserved).
 */
const NODES = [
  {
    id: "nodeA",
    name: "vault",
    kind: "agent",
    sshEnabled: true,
    access: "owner",
    status: "online",
    os: null,
    arch: null,
    maintenance: false,
  },
  {
    id: "nodeL",
    name: "plane",
    kind: "local",
    sshEnabled: true,
    access: "owner",
    status: "online",
    os: null,
    arch: null,
    maintenance: false,
  },
  {
    id: "nodeOff",
    name: "locked",
    kind: "agent",
    sshEnabled: false,
    access: "owner",
    status: "online",
    os: null,
    arch: null,
    maintenance: false,
  },
  {
    id: "nodeShare",
    name: "borrowed",
    kind: "agent",
    sshEnabled: true,
    access: "edit",
    status: "online",
    os: null,
    arch: null,
    maintenance: false,
  },
];

interface Sent {
  method: string;
  path: string;
  body?: unknown;
}

function stubFetch(
  restore: (undo: () => void) => void,
  opts: {
    revokeStatus?: number;
    revokeMessage?: string;
    /** The scripted key-home roster for the create picker (Task 18). */
    roster?: { fingerprint: string; comment: string }[];
    /** Status the roster read answers instead of 200 (the named-failure case). */
    rosterStatus?: number;
    rosterMessage?: string;
  } = {},
): Sent[] {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  restore(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    sent.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname === "/api/ssh/grants" && method === "POST") {
      const body = (sent.at(-1)?.body ?? {}) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          grant: { ...GRANT, id: "g-new", createdVia: "manual", ...body, resolvedSelector: body.selector },
        }),
        { status: 201 },
      );
    }
    if (url.pathname === "/api/ssh/grants/identities") {
      if (opts.rosterStatus) {
        return new Response(JSON.stringify({ message: opts.rosterMessage ?? "unreachable" }), {
          status: opts.rosterStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ identities: opts.roster ?? [{ fingerprint: ROSTER_ONE, comment: "work laptop" }] }),
        {
          status: 200,
        },
      );
    }
    if (url.pathname === "/api/ssh/grants") {
      return new Response(JSON.stringify({ grants: [GRANT] }), { status: 200 });
    }
    if (url.pathname === "/api/nodes") {
      return new Response(JSON.stringify({ nodes: NODES }), { status: 200 });
    }
    if (url.pathname === "/api/ssh/grants/g1" && method === "PATCH") {
      return new Response(JSON.stringify({ grant: { ...GRANT, ...(sent.at(-1)?.body as object) } }), { status: 200 });
    }
    if (url.pathname === "/api/ssh/grants/g1" && method === "DELETE") {
      if (opts.revokeStatus) {
        return new Response(JSON.stringify({ message: opts.revokeMessage ?? "gone" }), {
          status: opts.revokeStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`unstubbed fetch: ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return sent;
}

const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restores.splice(0)) undo();
});

function mockConfirm(answer: boolean) {
  const seen: ConfirmOptions[] = [];
  const previous = setConfirmHandler((options) => {
    seen.push(options);
    return Promise.resolve(answer);
  });
  return { seen, restore: () => setConfirmHandler(previous) };
}

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GrantsScreen />
    </QueryClientProvider>,
  );
}

describe("GrantsScreen", () => {
  it("lists each grant with its machine, selector and selected fingerprints", async () => {
    stubFetch((undo) => {
      restores.push(undo);
    });
    renderScreen();
    expect(await screen.findByText("prod keys")).toBeDefined();
    // The key home reads by NAME (rail doctrine: nothing rendered derives from the id).
    // The row's one detail line carries machine and selector, `machine · selector`.
    expect(screen.getByText(/vault/)).toBeDefined();
    expect(screen.getByText(/\*\.prod\.example\.com/)).toBeDefined();
    expect(screen.getByText(FP_ONE)).toBeDefined();
    expect(screen.getByText(FP_TWO)).toBeDefined();
  });

  it("says so plainly when there is nothing standing", async () => {
    const original = globalThis.fetch;
    restores.push(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = (async (input: unknown) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const body = path === "/api/ssh/grants" ? { grants: [] } : { nodes: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof globalThis.fetch;
    renderScreen();
    expect(await screen.findByText(/No key grants yet/)).toBeDefined();
  });

  it("revokes only after a confirm whose title is static, DELETEing the row", async () => {
    const sent = stubFetch((undo) => {
      restores.push(undo);
    });
    const confirm = mockConfirm(true);
    restores.push(confirm.restore);
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke grant prod keys" }));
    await waitFor(() => expect(confirm.seen.length).toBe(1));
    // Static title (design ruling 2026-09-30): the grant's name rides the body, never the heading.
    expect(confirm.seen[0]?.title).toBe("Revoke this grant?");
    expect(confirm.seen[0]?.description).toContain("prod keys");
    await waitFor(() => expect(sent.some((s) => s.method === "DELETE" && s.path === "/api/ssh/grants/g1")).toBe(true));
  });

  it("sends nothing when the confirm is declined", async () => {
    const sent = stubFetch((undo) => {
      restores.push(undo);
    });
    const confirm = mockConfirm(false);
    restores.push(confirm.restore);
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke grant prod keys" }));
    await waitFor(() => expect(confirm.seen.length).toBe(1));
    expect(sent.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("edits name and selector through PATCH, sending no fingerprints", async () => {
    const sent = stubFetch((undo) => {
      restores.push(undo);
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Edit grant prod keys" }));
    // Static dialog title (ruling 2026-09-30): the grant's name rides the body, never the heading.
    expect(await screen.findByRole("heading", { name: "Edit grant" })).toBeDefined();
    expect(screen.getByRole("dialog").textContent).toContain("prod keys");
    // The fields open pre-filled with what the row shows.
    expect((screen.getByLabelText(/Grant name/) as HTMLInputElement).value).toBe("prod keys");
    expect((screen.getByLabelText(/Destination hostname or pattern/) as HTMLInputElement).value).toBe(
      "*.prod.example.com",
    );
    fireEvent.change(screen.getByLabelText(/Grant name/), { target: { value: "staging keys" } });
    fireEvent.change(screen.getByLabelText(/Destination hostname or pattern/), {
      target: { value: "*.staging.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent.some((s) => s.method === "PATCH" && s.path === "/api/ssh/grants/g1")).toBe(true));
    const patch = sent.find((s) => s.method === "PATCH");
    // The body is exactly the two editable fields: which keys serve is immutable,
    // so fingerprints must never ride this PATCH (toEqual pins its absence).
    expect(patch?.body).toEqual({ name: "staging keys", selector: "*.staging.example.com" });
  });

  it("renders a refused revoke as the row's own red line", async () => {
    stubFetch(
      (undo) => {
        restores.push(undo);
      },
      { revokeStatus: 404, revokeMessage: "No such grant" },
    );
    const confirm = mockConfirm(true);
    restores.push(confirm.restore);
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke grant prod keys" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No such grant");
    expect(alert.className).toContain("text-destructive");
  });

  /* ---------------------------------------------------------------- */
  /* manual create (spec §8, Task 18): the roster-by-node picker       */
  /* ---------------------------------------------------------------- */

  /** Opens the create dialog and picks `vault`; returns once a row named `first` rendered. */
  async function openCreateAndPickKeyHome(first: string): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: "Create grant" }));
    const combo = screen.getByRole("combobox", { name: /SSH keys from/ });
    fireEvent.mouseDown(combo);
    fireEvent.click(combo);
    const option = await screen.findByRole("option", { name: /vault/ });
    // Base UI options answer the pointer triple; plain click never reaches onValueChange here.
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);
    await screen.findByText(first);
  }

  it("creates a grant: static title, the create-eligible key home only, and the POST carries node/name/selector/fingerprints", async () => {
    const sent = stubFetch((undo) => {
      restores.push(undo);
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Create grant" }));
    // Static title (ruling 2026-09-30): the act is the heading, data rides the body.
    expect(await screen.findByRole("heading", { name: "Create grant" })).toBeDefined();
    // The picker offers ONLY machines the create gate will accept: agent + SSH on
    // + owner. The control host, the SSH-off machine, and the shared one stay out.
    const combo = screen.getByRole("combobox", { name: /SSH keys from/ });
    fireEvent.mouseDown(combo);
    fireEvent.click(combo);
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["vault"]);
    const [vault] = options;
    if (!vault) throw new Error("the picker rendered no option");
    fireEvent.pointerDown(vault);
    fireEvent.pointerUp(vault);
    fireEvent.click(vault);

    // A's roster arrives from the roster-by-node read, not from any request.
    expect(await screen.findByText(ROSTER_ONE)).toBeDefined();
    expect(screen.getByText("work laptop")).toBeDefined();
    const rosterRead = sent.find((s) => s.path === "/api/ssh/grants/identities");
    expect(rosterRead?.method).toBe("GET");

    fireEvent.click(screen.getByRole("checkbox", { name: ROSTER_ONE }));
    fireEvent.change(screen.getByLabelText(/Grant name/), { target: { value: "by hand" } });
    fireEvent.change(screen.getByLabelText(/Destination hostname or pattern/), {
      target: { value: "*.git.example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(sent.some((s) => s.method === "POST" && s.path === "/api/ssh/grants")).toBe(true));
    // The body is exactly the existing create contract (grants.route.ts POST /grants).
    expect(sent.find((s) => s.method === "POST")?.body).toEqual({
      node: "nodeA",
      name: "by hand",
      selector: "*.git.example.test",
      fingerprints: [ROSTER_ONE],
    });
  });

  it("tick past the cap is a red hard error and sends nothing (never a truncation)", async () => {
    // One past SSH_MAX_GRANT_FINGERPRINTS (8), first entry the waitable
    // ROSTER_ONE so the helper can pin the roster landed before ticking.
    const nine = [
      { fingerprint: ROSTER_ONE, comment: "" },
      ...Array.from({ length: 8 }, (_, i) => ({
        fingerprint: `SHA256:${String(i + 1).padStart(43, "0")}`,
        comment: "",
      })),
    ];
    const sent = stubFetch(
      (undo) => {
        restores.push(undo);
      },
      { roster: nine },
    );
    renderScreen();
    await openCreateAndPickKeyHome(ROSTER_ONE);
    // The two text fields are filled FIRST (the create-flow test's own fills).
    // With them empty the button is already disabled by form validation, and a
    // disabled-at-9 assertion would pin the validator, not the cap: this test
    // must isolate the cap as the SOLE gate. Filled, exactly 8 ticks leave the
    // button ENABLED, so the 9th tick's disable can only be the cap.
    fireEvent.change(screen.getByLabelText(/Grant name/), { target: { value: "by hand" } });
    fireEvent.change(screen.getByLabelText(/Destination hostname or pattern/), {
      target: { value: "*.git.example.test" },
    });
    const createButton = () => screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    for (const identity of nine.slice(0, 8)) {
      fireEvent.click(screen.getByRole("checkbox", { name: identity.fingerprint }));
    }
    // At exactly the cap the form says yes: name, selector and eight ticks are
    // a complete draft. The generous timeout covers the async onChange
    // validator under full-suite parallelism, never the cap's own flip.
    await waitFor(() => expect(createButton().disabled).toBe(false), { timeout: 4000 });
    const ninth = nine[8];
    if (!ninth) throw new Error("the roster fixture lost its ninth entry");
    fireEvent.click(screen.getByRole("checkbox", { name: ninth.fingerprint }));
    // The cap bites: the red line names the limit, and the button falls back.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("at most 8");
    expect(alert.className).toContain("text-destructive");
    await waitFor(() => expect(createButton().disabled).toBe(true));
    // The button is swept and the guard behind it holds: nothing goes out.
    fireEvent.click(createButton());
    expect(sent.some((s) => s.method === "POST" && s.path === "/api/ssh/grants")).toBe(false);
  });

  it("an unreachable key home reads as its NAMED error, never as an empty roster", async () => {
    stubFetch(
      (undo) => {
        restores.push(undo);
      },
      {
        rosterStatus: 409,
        rosterMessage: "The key home has no live connection right now; bring its Subshell app online and ask again.",
      },
    );
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Create grant" }));
    const combo = screen.getByRole("combobox", { name: /SSH keys from/ });
    fireEvent.mouseDown(combo);
    fireEvent.click(combo);
    const option = await screen.findByRole("option", { name: /vault/ });
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no live connection");
    // The fabrication guard rendered as UI: an unreachable machine must not
    // look like "holds no keys", the honest empty answer's sentence.
    expect(alert.textContent).not.toMatch(/holds no keys/);
  });

  it("an honest empty roster says so and leaves Create disabled (nothing to select)", async () => {
    stubFetch(
      (undo) => {
        restores.push(undo);
      },
      { roster: [] },
    );
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Create grant" }));
    const combo = screen.getByRole("combobox", { name: /SSH keys from/ });
    fireEvent.mouseDown(combo);
    fireEvent.click(combo);
    const option = await screen.findByRole("option", { name: /vault/ });
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);
    expect(await screen.findByText(/holds no keys/)).toBeDefined();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
