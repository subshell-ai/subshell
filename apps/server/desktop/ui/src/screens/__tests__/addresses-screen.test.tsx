/**
 * **Server Addresses**, as component tests: the seeded-once-per-visit form
 * (never from a machine that could not be read), the blind hold and its way
 * out, the https note over the base-URL field, the Save gate, and the Force
 * box above the Restart it governs.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeProbe } from "../../__tests__/harness";
import type { AddressForm } from "../../lib/config-form";
import type { ActionResult } from "../../lib/ipc";
import { AddressesScreen } from "../addresses-screen";

afterEach(cleanup);

const STRINGS = {
  title: "Server Addresses",
  subtitle: "Where this server listens, and which addresses may reach it.",
  problem: "",
};

const KNOWN = makeProbe({
  next: "start",
  status: {
    configEnv: { path: "/Users/u/.config/subshell-server/config.env", exists: true },
    settings: {
      SERVER_PORT: { value: "4000", source: "configured" },
      HOST: { value: "0.0.0.0", source: "default" },
      APP_BASE_URL: { value: "http://localhost:4000", source: "default" },
      TRUSTED_ORIGINS: { value: "https://subshell.example.com", source: "configured" },
    },
    listen: null,
    mcp: { argv: [], source: "well-known" },
    mcpError: null,
  },
} as never);

const FORM: AddressForm = {
  values: {
    port: "4000",
    host: "0.0.0.0",
    baseUrl: "http://localhost:4000",
    trustedOrigins: "https://subshell.example.com",
  },
  explicit: { port: true, trustedOrigins: true },
};

function renderAddresses(over: {
  probe?: ReturnType<typeof makeProbe>;
  settingsForm?: AddressForm | null;
  blind?: boolean;
  forceChecked?: boolean | null;
  settingsResult?: ActionResult | null;
  busy?: boolean;
  onSeedForm?: (form: AddressForm) => void;
  onBlindChange?: (blind: boolean) => void;
  onRunSettings?: (fn: () => Promise<ActionResult>) => void;
  onSettingsEdit?: (values: AddressForm["values"], explicit: AddressForm["explicit"]) => void;
}) {
  return render(
    <AddressesScreen
      strings={STRINGS}
      probe={over.probe ?? KNOWN}
      busy={over.busy ?? false}
      running={false}
      settingsForm={over.settingsForm === undefined ? FORM : over.settingsForm}
      onSeedForm={over.onSeedForm ?? (() => {})}
      blind={over.blind ?? false}
      onBlindChange={over.onBlindChange ?? (() => {})}
      forceChecked={over.forceChecked ?? null}
      onForceToggle={() => {}}
      settingsResult={over.settingsResult ?? null}
      onSettingsEdit={over.onSettingsEdit ?? (() => {})}
      onRunSettings={over.onRunSettings ?? (() => {})}
      onClose={() => {}}
    />,
  );
}

describe("the hold", () => {
  it("shows the reading line and no form until a machine that can be read is in", () => {
    // A failed `status --json` with a server present: NOT a known machine, and
    // seeding here would prefill defaults over a configured 4000.
    const wedged = makeProbe({
      next: "unreachable",
      status: null,
      server: { argv: ["/usr/bin/subshell-server"], source: "local-bin", version: "0.12.0" },
      error: "status --json timed out",
    });
    renderAddresses({ probe: wedged, settingsForm: null });
    expect(screen.getByText("Reading this machine's configuration…")).toBeDefined();
    expect(screen.getByText("status --json timed out")).toBeDefined();
    expect(screen.getByText(/Saving writes exactly what you see here\./)).toBeDefined();
    // The hold has a way out.
    expect(screen.getByRole("button", { name: "Configure anyway" })).toBeDefined();
    expect(screen.queryByLabelText("Port")).toBeNull();
  });

  it("seeds from the machine once it is known, on the screen's first paint", () => {
    const onSeedForm = vi.fn();
    renderAddresses({ settingsForm: null, onSeedForm });
    expect(onSeedForm).toHaveBeenCalledTimes(1);
    const seeded = onSeedForm.mock.calls[0][0] as AddressForm;
    // The machine's own values, not the defaults: a configured port 4000.
    expect(seeded.values.port).toBe("4000");
    expect(seeded.explicit.port).toBe(true);
  });
});

describe("the form", () => {
  it("edits through the visit's own state, and lights Save only when something differs", () => {
    const onSettingsEdit = vi.fn();
    renderAddresses({ onSettingsEdit });
    const port = screen.getByLabelText("Port") as HTMLInputElement;
    expect(port.value).toBe("4000");
    // Save is dead until something is typed: a save of unchanged values would
    // read as the button having done something.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(port, { target: { value: "4001" } });
    expect(onSettingsEdit).toHaveBeenCalled();
  });

  it("toggles the https note in place as the base URL becomes https", () => {
    const { rerender } = renderAddresses({
      settingsForm: { ...FORM, values: { ...FORM.values, baseUrl: "http://localhost:4000" } },
    });
    const note = screen.getByText(/Changing the base URL will require an app restart and sign in\./);
    expect((note as HTMLElement).hidden).toBe(true);
    rerender(
      <AddressesScreen
        strings={STRINGS}
        probe={KNOWN}
        busy={false}
        running={false}
        settingsForm={{ ...FORM, values: { ...FORM.values, baseUrl: "https://subshell.example.com" } }}
        onSeedForm={() => {}}
        blind={false}
        onBlindChange={() => {}}
        forceChecked={null}
        onForceToggle={() => {}}
        settingsResult={null}
        onSettingsEdit={() => {}}
        onRunSettings={() => {}}
        onClose={() => {}}
      />,
    );
    expect(
      (screen.getByText(/Changing the base URL will require an app restart and sign in\./) as HTMLElement).hidden,
    ).toBe(false);
  });

  it("refuses Save on a machine without tmux, in the CLI's own words", () => {
    renderAddresses({ probe: makeProbe({ next: "start", tmux: null }) });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(/tmux is missing, and the server refuses to write its configuration without it\./),
    ).toBeDefined();
  });

  it("offers Restart with the Force box fail-closed above it, and the run through onRunSettings", () => {
    const onRunSettings = vi.fn();
    renderAddresses({
      onRunSettings,
      probe: makeProbe({
        next: "start",
        service: {
          installed: true,
          definitionPath: "/p",
          state: "running",
          pid: 1,
          enabled: true,
          paneSafety: "kills",
          detail: "",
        },
      }),
    });
    expect(screen.getByText(/this restart closes every subshell running here\./)).toBeDefined();
    screen.getByRole("button", { name: "Restart" }).click();
    expect(onRunSettings).toHaveBeenCalledTimes(1);
  });
});
