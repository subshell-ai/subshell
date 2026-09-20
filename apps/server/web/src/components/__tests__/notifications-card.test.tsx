import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { NotificationsCard } from "@/components/notifications-card";
import { resetDesktopShellForTests } from "@/lib/desktop";
import type { PushState } from "@/lib/notifications";

/**
 * The card is a state→words table; the tests pin each row. The lib hooks come
 * in through props (defaulted to the real ones in the component), so no
 * globals need stubbing here.
 *
 * The one thing it does read for itself is the live macOS permission line
 * (spec 2026-09-14 §5.4), which is a query — hence the provider. It is
 * disabled outside Subshell Server, so under these browser UAs it fetches
 * nothing and every row below is unchanged.
 */
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const noop = async (): Promise<PushState> => "off";

function stubUserAgent(ua: string): () => void {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const prev = Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", { value: ua, configurable: true, writable: true });
  // `desktopShell()` memoizes its parse at FIRST call (lib/desktop.ts), so a UA
  // stub is inert unless the memo is cleared too. Without this the card keeps
  // rendering whatever another test file's UA resolved it to — the reason these
  // rows passed in isolation but flipped under full-suite ordering.
  resetDesktopShellForTests();
  return () => {
    if (prev) Object.defineProperty(nav, "userAgent", prev);
    else delete nav.userAgent;
    resetDesktopShellForTests();
  };
}

beforeEach(() => {
  // A leaked memo from another file must not decide which branch renders here.
  resetDesktopShellForTests();
});

afterEach(() => {
  cleanup();
  resetDesktopShellForTests();
});

describe("NotificationsCard", () => {
  it("'off' offers the enable button and enablePush drives it to 'on'", async () => {
    const enableCalls: number[] = [];
    render(
      <NotificationsCard
        getState={async () => "off"}
        enable={async () => {
          enableCalls.push(1);
          return "on";
        }}
        disable={noop}
      />,
    );
    const button = await screen.findByRole("button", { name: "Enable notifications on this device" });
    fireEvent.click(button);
    await waitFor(() => screen.getByRole("button", { name: "Disable on this device" }));
    expect(enableCalls).toHaveLength(1);
  });

  it("'on' offers the disable button and disablePush drives it back to 'off'", async () => {
    const disableCalls: number[] = [];
    render(
      <NotificationsCard
        getState={async () => "on"}
        enable={noop}
        disable={async () => {
          disableCalls.push(1);
          return "off";
        }}
      />,
    );
    const button = await screen.findByRole("button", { name: "Disable on this device" });
    fireEvent.click(button);
    await waitFor(() => screen.getByRole("button", { name: "Enable notifications on this device" }));
    expect(disableCalls).toHaveLength(1);
  });

  it("'blocked' explains where the toggle lives instead of offering a button", async () => {
    render(<NotificationsCard getState={async () => "blocked"} enable={noop} disable={noop} />);
    expect(await screen.findByText("Allow notifications for subshell in your browser/OS settings.")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("'unconfigured' names the server-side cause", async () => {
    render(<NotificationsCard getState={async () => "unconfigured"} enable={noop} disable={noop} />);
    expect(
      await screen.findByText("This instance cannot issue push keys (data directory not writable)."),
    ).toBeDefined();
  });

  it("'unsupported' on a desktop UA shows the plain sentence only", async () => {
    const undo = stubUserAgent("Mozilla/5.0 (X11; Linux x86_64) Chrome");
    try {
      render(<NotificationsCard getState={async () => "unsupported"} enable={noop} disable={noop} />);
      expect(await screen.findByText("This browser does not support push notifications.")).toBeDefined();
      expect(screen.queryByText(/Add to Home Screen/)).toBeNull();
    } finally {
      undo();
    }
  });

  it("'unsupported' on iOS adds the Add-to-Home-Screen note", async () => {
    const undo = stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari");
    try {
      render(<NotificationsCard getState={async () => "unsupported"} enable={noop} disable={noop} />);
      expect(await screen.findByText(/Add to Home Screen/)).toBeDefined();
    } finally {
      undo();
    }
  });

  it("a failing probe falls back to the actionable 'off' state", async () => {
    render(
      <NotificationsCard
        getState={async () => {
          throw new Error("offline");
        }}
        enable={noop}
        disable={noop}
      />,
    );
    expect(await screen.findByRole("button", { name: "Enable notifications on this device" })).toBeDefined();
  });
});
