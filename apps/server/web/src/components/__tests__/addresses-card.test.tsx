import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deploymentView, idleRestart } from "@/components/__tests__/helpers/deployment-view";
import { AddressesCard, invalidField } from "@/components/service/addresses-card";
import { ApiError } from "@/lib/api";

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

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
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
