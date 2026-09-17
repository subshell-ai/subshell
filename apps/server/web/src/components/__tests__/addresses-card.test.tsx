import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deploymentView, idleRestart } from "@/components/__tests__/helpers/deployment-view";
import { AddressesCard, invalidField } from "@/components/networking/addresses-card";
import { ApiError } from "@/lib/api";

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

/** Records PATCH bodies and answers with a fresh view. */
function stubPatch(): unknown[] {
  const sent: unknown[] = [];
  const original = globalThis.fetch;
  restore.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ...deploymentView(), restartRequired: true, warnings: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return sent;
}

function renderCard(view = deploymentView()) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddressesCard view={view} restart={idleRestart} />
    </QueryClientProvider>,
  );
}

describe("AddressesCard", () => {
  it("renders a field set by the environment read-only with the reason", () => {
    renderCard(deploymentView({ HOST: { saved: "127.0.0.1", source: "process env", running: "127.0.0.1" } }));
    const host = screen.getByLabelText("Bind address") as HTMLInputElement;
    expect(host.readOnly).toBe(true);
    expect(screen.getByText(/Set by the environment \(HOST\)/)).toBeTruthy();
  });

  it("PATCHes only the fields the person touched", async () => {
    const sent: unknown[] = [];
    const original = globalThis.fetch;
    restore.push(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      const answered = deploymentView({ SERVER_PORT: { saved: "3090", source: "config.env", running: "3080" } });
      return new Response(JSON.stringify({ ...answered, restartRequired: true, warnings: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    renderCard();
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "3090" } });
    // "Save and restart" where a restart is possible, which the fixture is.
    fireEvent.click(screen.getByRole("button", { name: "Save and restart" }));
    await waitFor(() => expect(sent).toEqual([{ port: 3090 }]));
  });

  it("shows the restart strip whenever the VIEW says a restart is pending", () => {
    const view = deploymentView({ SERVER_PORT: { saved: "3090", source: "config.env", running: "3080" } });
    view.restartRequired = true;
    renderCard(view);
    // Driven by the view, not by this card's own last save — so a hand edit
    // over ssh raises it too.
    expect(screen.getByText(/Restart the server to apply/)).toBeTruthy();
  });

  it("renders a rejected entry's reason under its field", () => {
    renderCard(
      deploymentView({
        TRUSTED_ORIGINS: {
          saved: "https://*",
          source: "config.env",
          running: "",
          problems: [{ entry: "https://*", reason: "Wildcards are not accepted" }],
        },
      }),
    );
    expect(screen.getByText(/Wildcards are not accepted/)).toBeTruthy();
  });
});

describe("invalidField", () => {
  /** The shape `apiFetch` throws for a 400 the route answered with a code. */
  const refusal = (message: string, code = "CONFIG_INVALID") => new ApiError(400, message, { code });

  it("routes a CONFIG_INVALID reason to the field the route named", () => {
    // The route answers `"<CONFIG KEY>: <reason>"` — the CLI's own sentence,
    // naming the config key rather than this form's field label.
    expect(invalidField(refusal("SERVER_PORT: Port must be between 1 and 65535"))).toEqual({
      key: "SERVER_PORT",
      reason: "Port must be between 1 and 65535",
    });
    expect(invalidField(refusal("TRUSTED_ORIGINS: Wildcards are not accepted"))).toEqual({
      key: "TRUSTED_ORIGINS",
      reason: "Wildcards are not accepted",
    });
  });

  it("names no field for a refusal that is about the file rather than a value", () => {
    // An unreadable config.env comes back as BAD_REQUEST with no key in it,
    // and belongs at form level.
    expect(invalidField(refusal("config.env could not be read: EACCES", "BAD_REQUEST"))).toBeNull();
    expect(invalidField(refusal("DATABASE_PATH: not settable here"))).toBeNull();
    expect(invalidField(new Error("network"))).toBeNull();
    expect(invalidField(null)).toBeNull();
  });
});

describe("form validation", () => {
  const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const save = () => fireEvent.click(screen.getByRole("button", { name: /^Save/ }));

  it("refuses a bad value before the request, under the field it is about", () => {
    const sent = stubPatch();
    renderCard();
    edit("Port", "99999");
    save();
    // The SERVER'S own words: this form imports `validateValue` rather than
    // restating its rules, so the sentence is the one the CLI prints too.
    expect(screen.getByText(/expected an integer 1-65535/)).toBeTruthy();
    // And nothing was sent, which is the point — not saving the bad value.
    expect(sent).toEqual([]);
  });

  it("catches the subtle ones a hand-written validator would not have", () => {
    stubPatch();
    renderCard();
    // A leading zero parses as a port and writes an UNBOOTABLE config.env,
    // because the boot path reads it through a stricter parser. Nobody would
    // think to write this rule twice; importing it means nobody has to.
    edit("Port", "080");
    save();
    expect(screen.getByText(/leading zero/)).toBeTruthy();
  });

  it("refuses an origin a browser could never match", () => {
    stubPatch();
    renderCard();
    edit("Other addresses browsers will use", "box.local:3080");
    save();
    // The exact sentence is the validator's, and it is NOT the one the view's
    // `problems` array uses for the same input — writing this expectation by
    // hand got it wrong, which is the drift importing the rules removes.
    expect(screen.getByText(/expected a bare http\(s\) origin with no path/)).toBeTruthy();
  });

  it("ACCEPTS a trailing comma, because the route would have", async () => {
    const sent = stubPatch();
    renderCard();
    // This used to be refused. The patch builder drops empty entries, so the
    // route received a clean list and accepted it — the form was rejecting
    // input its own patch builder would have fixed, which is strictly worse
    // than a round trip and the opposite of what importing the server's rules
    // was for. Validation now runs on the string the route will see.
    edit("Other addresses browsers will use", "http://localhost:5173, ");
    save();
    expect(screen.queryByText(/stray or trailing comma/)).toBeNull();
    await waitFor(() => expect(sent).toEqual([{ trustedOrigins: ["http://localhost:5173"] }]));
  });

  it("still refuses an entry that normalizing cannot save", () => {
    stubPatch();
    renderCard();
    // Trimming and dropping blanks does not make this an origin, so the
    // refusal stands — the relaxation above is about whitespace, not about
    // letting the route decide everything.
    edit("Other addresses browsers will use", "http://localhost:5173, box.local:3080");
    save();
    expect(screen.getByText(/expected a bare http\(s\) origin with no path/)).toBeTruthy();
  });

  it("clears a stale SERVER refusal when a later click never reaches the route", async () => {
    const sent = stubPatch();
    // A view nothing supervises, so Save does NOT open the restart dialog —
    // that dialog is modal and marks the card behind it aria-hidden, which
    // would hide the very text under test. The behaviour being pinned has
    // nothing to do with restarting.
    const unsupervised = deploymentView();
    unsupervised.restart = { available: false, reason: "not supervised" };
    renderCard(unsupervised);
    edit("Port", "3081");
    save();
    await waitFor(() => expect(sent.length).toBe(1));

    // A second attempt that fails client-side must not leave the previous
    // round trip's message on screen: it describes a value that is no longer
    // in the form, so it reads as "the server refuses my corrected input".
    edit("Port", "99999");
    save();
    expect(screen.getByText(/expected an integer 1-65535/)).toBeTruthy();
    expect(sent.length).toBe(1);
  });

  it("clears a field's complaint when it is edited, and leaves the others", () => {
    stubPatch();
    renderCard();
    edit("Port", "99999");
    edit("Public base URL", "not-a-url");
    save();
    expect(screen.getByText(/expected an integer 1-65535/)).toBeTruthy();
    expect(screen.getByText(/expected a full http\(s\) URL/)).toBeTruthy();

    edit("Port", "3081");
    // Being worked on, so its complaint goes; the other is still true.
    expect(screen.queryByText(/expected an integer 1-65535/)).toBeNull();
    expect(screen.getByText(/expected a full http\(s\) URL/)).toBeTruthy();
  });

  it("sends a valid change", async () => {
    const sent = stubPatch();
    renderCard();
    edit("Port", "3081");
    save();
    await waitFor(() => expect(sent).toEqual([{ port: 3081 }]));
  });
});

describe("the keys the server reads live", () => {
  const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it("a change to only the origins field saves without offering a restart", async () => {
    // TRUSTED_ORIGINS stopped being a boot-time key on 2026-09-16: the server
    // re-reads config.env's extras on every request. "Save and restart" over
    // that change offered an act that applies nothing.
    const sent = stubPatch();
    renderCard();
    edit("Other addresses browsers will use", "http://box.local:3080");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save and restart" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toEqual([{ trustedOrigins: ["http://box.local:3080"] }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a change that also touches a boot-time key still says Save and restart", () => {
    stubPatch();
    renderCard();
    edit("Other addresses browsers will use", "http://box.local:3080");
    edit("Port", "3081");
    expect(screen.getByRole("button", { name: "Save and restart" })).toBeTruthy();
  });

  it("says that network addresses are trusted automatically and this field is for the rest", () => {
    renderCard();
    expect(screen.getByText(/joined under Networking are trusted automatically/)).toBeTruthy();
  });
});
