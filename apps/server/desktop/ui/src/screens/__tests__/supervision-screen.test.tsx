/**
 * The supervision screen, as component tests: the two choice rows, the login
 * box and its reasons, the unchanged gate on Apply, and the CLI's words where
 * the person still is.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { makeProbe } from "../../__tests__/harness";
import type { ActionResult } from "../../lib/ipc";
import { SupervisionScreen } from "../supervision-screen";

afterEach(cleanup);

const STRINGS = { title: "How Your Server Runs", subtitle: "Change who starts it, and when.", problem: "" };

function renderSupervision(over: {
  probe?: ReturnType<typeof makeProbe>;
  supervisionForm?: { background: boolean; autostart: boolean } | null;
  failure?: ActionResult | null;
  busy?: boolean;
  onChoice?: (next: { background: boolean; autostart: boolean }) => void;
  onApply?: (chosen: { background: boolean; autostart: boolean }) => void;
}) {
  return render(
    <SupervisionScreen
      strings={STRINGS}
      probe={over.probe ?? makeProbe()}
      busy={over.busy ?? false}
      running={false}
      failure={over.failure ?? null}
      supervisionForm={over.supervisionForm ?? null}
      onChoice={over.onChoice ?? (() => {})}
      onApply={over.onApply ?? (() => {})}
      onClose={() => {}}
    />,
  );
}

describe("the choice rows", () => {
  it("opens on the machine's own answer", () => {
    // service mode, armed for login: the machine's real state, not a default.
    renderSupervision({
      probe: makeProbe({
        supervision: "service",
        service: {
          installed: true,
          definitionPath: "/p",
          state: "running",
          pid: 1,
          enabled: true,
          paneSafety: "keeps",
          detail: "",
        },
      }),
    });
    expect((screen.getByLabelText(/^In the background/) as HTMLInputElement).checked).toBe(true);
    // The kit Switch renders the labelled control as a hidden native input,
    // so the test reads it by id — getByLabelText would match both it and the
    // role=switch span Base UI names through the same label.
    expect((document.getElementById("sup-login") as HTMLInputElement).checked).toBe(true);
    expect(
      screen.getByText(
        "Currently the Subshell Server Service runs in the background, and starts automatically on startup.",
      ),
    ).toBeDefined();
  });

  it("picks the app mode through the model's dependency rule", () => {
    const onChoice = vi.fn();
    renderSupervision({ probe: makeProbe({ supervision: "service", service: null }), onChoice });
    screen.getByLabelText(/^With this app/).click();
    // Going app takes the login box with it — arming login means nothing
    // without a service.
    expect(onChoice).toHaveBeenCalledWith({ background: false, autostart: false });
  });

  it("re-arms login at the default when a service is picked back", () => {
    const onChoice = vi.fn();
    // A half-choice left over from a visit would otherwise undo itself: the
    // pending choice rides the host state, and the model restores the default.
    renderSupervision({ probe: makeProbe(), onChoice, supervisionForm: { background: false, autostart: false } });
    screen.getByLabelText(/^In the background/).click();
    expect(onChoice).toHaveBeenCalledWith({ background: true, autostart: true });
  });

  it("disables the login box in app mode, and explains an old server", () => {
    renderSupervision({
      probe: makeProbe({
        supervision: "app",
        service: null,
        server: { argv: ["/usr/bin/subshell-server"], source: "local-bin", version: "0.8.0" },
      }),
    });
    const login = document.getElementById("sup-login") as HTMLInputElement;
    expect(login.disabled).toBe(true);
    expect(screen.getByText("Update your server to 0.9.0 to control this.")).toBeDefined();
  });
});

describe("the Apply gate", () => {
  it("is dead while the choice is the machine's own", () => {
    renderSupervision({});
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("fires the chosen answer once it differs, and the leave label says where back is", () => {
    const onApply = vi.fn();
    renderSupervision({ supervisionForm: { background: false, autostart: false }, onApply });
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    apply.click();
    expect(onApply).toHaveBeenCalledWith({ background: false, autostart: false });
    // A ready machine has the handoff behind it: the leave is Close, not Back.
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
  });
});

describe("the CLI's own words", () => {
  it("renders where the person still is, styled as a failure", () => {
    renderSupervision({ failure: { ok: false, stdout: "", stderr: "launchctl: bootstrap failed: 5" } });
    const out = document.querySelector("pre.output");
    expect(out?.textContent).toBe("launchctl: bootstrap failed: 5");
    expect(out?.className).toContain("output-bad");
  });
});
