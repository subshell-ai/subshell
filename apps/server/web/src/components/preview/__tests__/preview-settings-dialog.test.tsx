import { afterEach, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PreviewSettingsDialog } from "../preview-settings-dialog";

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
it("loads personal settings and saves a saved-service target before opening", async () => {
  const bodies: Record<string, unknown>[] = [];
  const settings = { rewriteUrls: true, passHost: false, rewriteRedirects: true };
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return Response.json(body.action === "save" ? body.settings : settings);
  }) as typeof fetch;
  let opened = 0;
  let closed = 0;
  render(
    <PreviewSettingsDialog
      paneId="pane"
      port={3000}
      serviceId="service"
      onClose={() => {
        closed++;
      }}
      onOpen={() => {
        opened++;
      }}
    />,
  );
  const host = await screen.findByRole("checkbox", { name: "Pass the preview host" });
  expect(host.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(host);
  await waitFor(() => expect(host.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(screen.getByRole("button", { name: "Save and open" }));
  await waitFor(() => expect(opened).toBe(1));
  expect(closed).toBe(1);
  expect(bodies.at(-1)).toEqual({
    target: { serviceId: "service" },
    action: "save",
    settings: { ...settings, passHost: true },
  });
});
it("cancellation preserves the current preview without saving", async () => {
  let writes = 0;
  let opened = 0;
  let closed = 0;
  globalThis.fetch = (async (_url, init) => {
    if (JSON.parse(String(init?.body)).action !== "read") writes++;
    return Response.json({ rewriteUrls: true, passHost: false, rewriteRedirects: true });
  }) as typeof fetch;
  render(
    <PreviewSettingsDialog
      paneId="pane"
      port={3000}
      onClose={() => {
        closed++;
      }}
      onOpen={() => {
        opened++;
      }}
    />,
  );
  await screen.findByRole("checkbox", { name: "Rewrite app URLs" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(closed).toBe(1);
  expect(opened).toBe(0);
  expect(writes).toBe(0);
});
it("reset removes saved settings and opens defaults", async () => {
  let action = "";
  let opened = 0;
  globalThis.fetch = (async (_url, init) => {
    action = JSON.parse(String(init?.body)).action;
    return Response.json({ rewriteUrls: true, passHost: false, rewriteRedirects: true });
  }) as typeof fetch;
  render(
    <PreviewSettingsDialog
      paneId="pane"
      port={3000}
      onClose={() => {}}
      onOpen={() => {
        opened++;
      }}
    />,
  );
  await screen.findByRole("checkbox", { name: "Rewrite app URLs" });
  fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
  await waitFor(() => expect(opened).toBe(1));
  expect(action).toBe("reset");
});
