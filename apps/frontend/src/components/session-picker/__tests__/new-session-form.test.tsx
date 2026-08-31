import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  emptyNewSessionForm,
  NewSessionForm,
  type NewSessionFormValue,
} from "@/components/session-picker/new-session-form";

/** Serves the two endpoints the form reads; recentPaths is what varies. */
function mockEndpoints(paths: { path: string; label: string | null }[]) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = String(input);
    if (url.includes("/api/files/recent")) {
      return Promise.resolve(new Response(JSON.stringify({ paths })));
    }
    return Promise.resolve(new Response(JSON.stringify([]))); // /api/profiles
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** A controlled parent like /new and the dialog. */
function renderForm(initial: NewSessionFormValue) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [value, setValue] = useState(initial);
    return <NewSessionForm value={value} onChange={setValue} />;
  }
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

const dir = () => screen.getByLabelText("Working directory") as HTMLInputElement;

describe("NewSessionForm working-dir pre-fill", () => {
  afterEach(cleanup);

  it("fills an empty working dir with the most recent path", async () => {
    const restore = mockEndpoints([
      { path: "/srv/app", label: "app" },
      { path: "/srv/older", label: null },
    ]);
    try {
      renderForm(emptyNewSessionForm());
      await waitFor(() => expect(dir().value).toBe("/srv/app"));
    } finally {
      restore();
    }
  });

  it("never overwrites a working dir the caller already set", async () => {
    const restore = mockEndpoints([{ path: "/srv/app", label: null }]);
    try {
      renderForm({ ...emptyNewSessionForm(), workingDir: "/keep/me" });
      // Give the query time to land and (mis)fire before asserting absence.
      await new Promise((r) => setTimeout(r, 50));
      expect(dir().value).toBe("/keep/me");
    } finally {
      restore();
    }
  });

  it("stays empty when the user has no history yet", async () => {
    const restore = mockEndpoints([]);
    try {
      renderForm(emptyNewSessionForm());
      await new Promise((r) => setTimeout(r, 50));
      expect(dir().value).toBe("");
    } finally {
      restore();
    }
  });

  it("respects a user typing over the pre-fill (applies once per mount)", async () => {
    const restore = mockEndpoints([{ path: "/srv/app", label: null }]);
    try {
      renderForm(emptyNewSessionForm());
      await waitFor(() => expect(dir().value).toBe("/srv/app"));
      fireEvent.change(dir(), { target: { value: "" } }); // deliberate clear
      await new Promise((r) => setTimeout(r, 50));
      expect(dir().value).toBe("");
    } finally {
      restore();
    }
  });
});
