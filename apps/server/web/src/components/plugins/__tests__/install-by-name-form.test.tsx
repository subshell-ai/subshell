import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InstallByNameForm } from "@/components/plugins/install-by-name-form";
import type { InstancePluginRow } from "@/hooks/use-instance-plugins";

/**
 * The gating sweep (spec 2026-09-29): the Install button stays ABSENT while
 * the name is empty (unchanged ruling — an empty field is nothing to
 * install), and once a name is typed the button is disabled until the id the
 * install would actually use exists, with the sentence under the id box
 * naming the problem as the person types.
 */

afterEach(cleanup);

const piRow = { id: "pi", name: "Pi", description: "drives pi", installed: false, builtIn: true } as InstancePluginRow;

function renderForm(plugins: InstancePluginRow[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <InstallByNameForm plugins={plugins} />
    </QueryClientProvider>,
  );
}

const specField = () => screen.getByLabelText("Install from npm") as HTMLInputElement;
const idField = () => screen.getByLabelText("Plugin id") as HTMLInputElement;
const installButton = () => screen.queryByRole("button", { name: "Install" }) as HTMLButtonElement | null;

describe("InstallByNameForm gating", () => {
  it("no button at all while the name is empty", () => {
    renderForm([piRow]);
    expect(installButton()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a built-in name opens the gate immediately (the fast path is one click)", () => {
    renderForm([piRow]);
    fireEvent.change(specField(), { target: { value: "pi" } });
    expect(installButton()?.disabled).toBe(false);
  });

  it("an unusable derived id disables the button and says why, with no press needed", () => {
    renderForm([piRow]);
    fireEvent.change(specField(), { target: { value: "@acme/" } }); // derives to nothing
    expect(installButton()).not.toBeNull();
    expect(installButton()?.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(
      "That package name gives no usable plugin id. Name the id the plugin declares.",
    );
    // Naming the id the plugin declares opens the gate.
    fireEvent.change(idField(), { target: { value: "acme-pi" } });
    expect(installButton()?.disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clearing the name makes the button (and the sentence) disappear again", () => {
    renderForm([piRow]);
    fireEvent.change(specField(), { target: { value: "@acme/" } });
    expect(screen.getByRole("alert")).toBeDefined();
    fireEvent.change(specField(), { target: { value: "" } });
    expect(installButton()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
