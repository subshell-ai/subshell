import { afterEach, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PreviewToolbar, type PreviewToolbarProps } from "../preview-toolbar";

afterEach(cleanup);
function props(overrides: Partial<PreviewToolbarProps> = {}): PreviewToolbarProps {
  return {
    selected: "app:41430",
    onRefresh: () => {},
    onDisconnect: () => {},
    onFullscreen: () => {},
    fullscreen: false,
    fullscreenSupported: true,
    appUrl: "/pv/example/",
    busy: false,
    connection: "connected",
    ...overrides,
  };
}
it("keeps secondary actions in More, including an actual browser-tab link", async () => {
  let closed = 0;
  render(
    <PreviewToolbar
      {...props({
        onDisconnect: () => {
          closed += 1;
        },
      })}
    />,
  );
  expect(screen.queryByRole("menuitem", { name: "Close preview" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More preview actions" }));
  const link = await screen.findByRole("menuitem", { name: "Open in browser tab" });
  expect(link.getAttribute("href")).toBe("/pv/example/");
  expect(link.getAttribute("target")).toBe("_blank");
  fireEvent.click(screen.getByRole("menuitem", { name: "Close preview" }));
  expect(closed).toBe(1);
});
it("refreshes the current view and explains a pending selection", () => {
  let refreshed = 0;
  const view = render(
    <PreviewToolbar
      {...props({
        onRefresh: () => {
          refreshed += 1;
        },
      })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
  expect(refreshed).toBe(1);
  view.rerender(<PreviewToolbar {...props({ busy: true })} />);
  expect(screen.getByRole("button", { name: "Refresh preview" }).getAttribute("aria-disabled")).toBe("true");
});
