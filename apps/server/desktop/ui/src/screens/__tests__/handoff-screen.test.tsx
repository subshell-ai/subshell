import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { makeProbe } from "../../__tests__/harness";
import { DEFAULT_SUPERVISION } from "../../lib/wizard-state";
import { HandoffScreen } from "../handoff-screen";

afterEach(cleanup);

const STRINGS = { title: "Subshell Server Is Ready", subtitle: "Everything below is set up and running.", problem: "" };

const READY = makeProbe({ next: "ready", onboarded: true });

function renderHandoff(over: {
  waiting?: boolean;
  openFailed?: boolean;
  onContinue?: () => void;
  onRetryOpen?: () => void;
}) {
  return render(
    <HandoffScreen
      strings={STRINGS}
      probe={READY}
      busy={false}
      form={{ port: "", host: "", baseUrl: "", trustedOrigins: "" }}
      supervision={DEFAULT_SUPERVISION}
      openFailed={over.openFailed ?? false}
      onRetryOpen={over.onRetryOpen ?? (() => {})}
      waiting={over.waiting ?? false}
      onContinue={over.onContinue ?? (() => {})}
    />,
  );
}

describe("HandoffScreen", () => {
  it("waits on the completed checklist with the person's Continue", () => {
    const onContinue = vi.fn();
    renderHandoff({ waiting: true, onContinue });
    // The checklist stays on screen, every row ticked: it is the answer to
    // "what did that just do".
    expect(document.querySelectorAll("ul.checklist li")).toHaveLength(5);
    screen.getByRole("button", { name: "Continue" }).click();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("draws nothing but the title on the auto path", () => {
    renderHandoff({ waiting: false });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Subshell Server Is Ready");
    // The host's openWhenReady effect does the opening; the screen has no
    // control to press.
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  it("lets the human press when the dashboard refused to open", () => {
    const onRetryOpen = vi.fn();
    render(
      <HandoffScreen
        // The strings are the host's per-arm shell; the screen's own job is the branch.
        strings={{ title: "Subshell Is Running", subtitle: "The control plane did not open by itself.", problem: "" }}
        probe={READY}
        busy={false}
        form={{ port: "", host: "", baseUrl: "", trustedOrigins: "" }}
        supervision={DEFAULT_SUPERVISION}
        openFailed
        onRetryOpen={onRetryOpen}
        waiting={false}
        onContinue={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Subshell Is Running");
    screen.getByRole("button", { name: "Open control plane" }).click();
    expect(onRetryOpen).toHaveBeenCalledTimes(1);
  });
});
