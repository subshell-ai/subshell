import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ROUND_TRIP_REFUSED } from "@/lib/sign-in-diagnosis";
import { Route } from "@/routes/login";
import { setFetchRouter } from "@/test-setup";

/**
 * What the login page DOES with an unrecognized OAuth round-trip refusal
 * (final review, Important 2). The mapper classifies the codes, but the
 * review's finding was about the PAGE: `?error=provider_closed` (and every other
 * code outside the two special readings) used to be stripped out of the URL
 * while nothing rendered — a visitor back from a full IdP round trip on a
 * pristine form with zero feedback. These cases pin the shipped pair: the
 * sentence RENDERS (the description as prose, or the generic fallback), the
 * consumed params are stripped from the URL WITHOUT taking the line with
 * them (the decision was made at mount), and a fresh attempt retires the
 * stale refusal before the form's own error takes its place (the clear-on-
 * mount effect, carried minor #4).
 */

function stubWires(signedIn = false) {
  setFetchRouter((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/auth/get-session") {
      return Promise.resolve(
        signedIn
          ? new Response(JSON.stringify({ user: { id: "u1", name: "Ada", email: "ada@example.com" } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ message: "Unauthorized" }), {
              status: 401,
              headers: { "content-type": "application/json" },
            }),
      );
    }
    if (url.pathname === "/api/settings/instance") {
      return Promise.resolve(
        new Response(JSON.stringify({ instanceName: "Test Plane", providers: [], emailSignIn: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.pathname === "/api/auth/sign-in/email") {
      // The better-auth error shape: a non-2xx JSON body's message reaches
      // `signInError.message`, which the form renders in ITS error surface.
      return Promise.resolve(
        new Response(JSON.stringify({ message: "Invalid email or password" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
}

function renderLogin(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const loginRoute = Route.update({
    id: "/login",
    path: "/login",
    getParentRoute: () => rootRoute,
  } as Parameters<typeof Route.update>[0]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([loginRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    defaultPreload: false,
    defaultNotFoundComponent: () => null,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("/login round-trip refusals", () => {
  afterEach(() => {
    setFetchRouter(null);
    cleanup();
  });

  it("renders an unrecognized refusal's description and survives the param strip", async () => {
    stubWires();
    const router = renderLogin("/login?error=provider_closed&error_description=That%20provider%20is%20closed.");
    await screen.findByText("That provider is closed.");
    // The consumed params leave the URL (a later form error must not sit
    // beside the old refusal — Task 14 review, minor 1). TanStack exposes
    // the PARSED search, so "stripped" means an empty object, not ""…
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    // …and the LINE stays: it was decided at mount, not read from the live
    // params, so the strip cannot blink it out with them.
    expect(screen.getByText("That provider is closed.")).toBeDefined();
  });

  it("renders the generic fallback when the refusal carried no description", async () => {
    stubWires();
    renderLogin("/login?error=registration_closed");
    await screen.findByText(ROUND_TRIP_REFUSED);
  });

  it("a fresh sign-in attempt retires the captured refusal", async () => {
    stubWires();
    renderLogin("/login?error=provider_closed&error_description=Old%20refusal");
    await screen.findByText("Old refusal");
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /^Sign in$/ }));
    // The form's OWN error surface takes the stage; the stale round-trip
    // line is gone (both live at once was the Task 14 re-review nit, and
    // the clear-on-mount effect has had no other coverage — carried minor 4).
    await screen.findByText("Invalid email or password");
    expect(screen.queryByText("Old refusal")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Signing in/ })).toBeNull());
  });

  it("a fresh mount with no params paints no refusal line", async () => {
    stubWires();
    renderLogin("/login");
    await screen.findByLabelText("E-mail");
    expect(screen.queryByText(ROUND_TRIP_REFUSED)).toBeNull();
    expect(screen.queryByText(/refused/i)).toBeNull();
  });
});
