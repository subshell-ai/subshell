/**
 * The Reset screen, as component tests: the refusal gate (an incomplete paths
 * block arms nothing), the hostname gate the page shares with Rust, the two
 * panes and their meter, and the action row's busy states.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { makeProbe } from "../../__tests__/harness";
import { emptySteps } from "../../lib/reset";
import { ResetScreen } from "../reset-screen";

afterEach(cleanup);

/** A machine whose server reports its data locations: the resettable case. */
const RESETTABLE = makeProbe({
  next: "start",
  hostname: "testhost",
  status: {
    configEnv: { path: "/Users/u/.config/subshell-server/config.env", exists: true },
    paths: {
      dataDir: "/Users/u/.local/share/subshell-server",
      database: "/Users/u/.local/share/subshell-server/db.sqlite",
      logsDir: "/Users/u/.local/share/subshell-server/logs",
      nodeArtifacts: "/Users/u/.local/share/subshell-server/node-artifacts",
    },
    listen: { port: 3080, listening: true },
  },
} as never);

function renderReset(over: {
  probe?: typeof RESETTABLE | null;
  busy?: boolean;
  steps?: ReturnType<typeof emptySteps>;
  armingProblem?: string | null;
  runLabel?: string;
  log?: { text: string; bad: boolean } | null;
  typed?: string;
  onRunReset?: (typed: string) => void;
  onCancel?: () => void;
}) {
  // The typed hostname is HOST state now, so the helper holds it the way the
  // host does — the change handler feeds the state back.
  return render(<ResetScreenHolder over={over} />);
}

function ResetScreenHolder(props: { over: Parameters<typeof renderReset>[0] }) {
  const over = props.over;
  const [typed, setTyped] = useState(over.typed ?? "");
  return (
    <ResetScreen
      probe={over.probe === undefined ? RESETTABLE : over.probe}
      busy={over.busy ?? false}
      steps={over.steps ?? emptySteps()}
      armingProblem={over.armingProblem ?? null}
      runLabel={over.runLabel ?? "Reset everything"}
      log={over.log ?? null}
      typed={typed}
      onTypedChange={setTyped}
      onRunReset={over.onRunReset ?? (() => {})}
      onCancel={over.onCancel ?? (() => {})}
    />
  );
}

// Through the DOM, act-wrapped: the holder's state feeds back through
// `onTypedChange`, exactly as the host's does.
const typeHostname = (value: string): void => {
  fireEvent.change(document.getElementById("reset-confirm") as HTMLInputElement, { target: { value } });
};

describe("the refusal gate", () => {
  it("refuses to arm when the server does not report its data locations", () => {
    renderReset({ probe: makeProbe({ next: "start", hostname: "testhost", status: null }) });
    // No promises without the block to promise from.
    expect(document.querySelector("ul.wizard-copy.list-disc")?.children.length ?? 0).toBe(0);
    expect((screen.getByRole("button", { name: "Reset everything" }) as HTMLButtonElement).disabled).toBe(true);
    // The verdict renders TWICE, as the old screen did: the refusal line above,
    // and the reason beside the control it disables.
    expect(screen.getAllByText(/Reset refuses to guess at a filesystem\./)).toHaveLength(2);
  });

  it("lists the five promises once the paths are complete, and holds the button until the name matches", () => {
    const _view = renderReset({});
    const rows = document.querySelectorAll("ul.wizard-copy.list-disc li");
    expect(rows).toHaveLength(5);
    expect(rows[0].textContent).toContain("Database (users, sessions, API keys, the node signing keypair)");
    expect((screen.getByRole("button", { name: "Reset everything" }) as HTMLButtonElement).disabled).toBe(true);
    typeHostname("testhost");
    expect((screen.getByRole("button", { name: "Reset everything" }) as HTMLButtonElement).disabled).toBe(false);
    // The compare is exact: Rust compares the same memoized name.
    typeHostname("TestHost");
    expect((screen.getByRole("button", { name: "Reset everything" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names an unreadable hostname as its own refusal", () => {
    renderReset({ probe: { ...RESETTABLE, hostname: "" } });
    expect(screen.getByText(/This machine's name could not be read/)).toBeDefined();
    typeHostname("testhost");
    expect((screen.getByRole("button", { name: "Reset everything" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the arming verdict where the refusal would be", () => {
    const _view = renderReset({ armingProblem: "The reset could not be staged: command not found." });
    expect(screen.getAllByText(/The reset could not be staged/).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Reset everything" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the run press and its meter", () => {
  it("fires only when armed, with the typed string", () => {
    const onRunReset = vi.fn();
    const _view = renderReset({ onRunReset });
    screen.getByRole("button", { name: "Reset everything" }).click();
    expect(onRunReset).not.toHaveBeenCalled(); // disabled: empty box
    typeHostname("testhost");
    screen.getByRole("button", { name: "Reset everything" }).click();
    expect(onRunReset).toHaveBeenCalledWith("testhost");
  });

  it("replaces the confirmation with the meter once the chain has touched anything", () => {
    renderReset({ steps: { ...emptySteps(), plan: "running", stop: "done" } });
    // The promises are gone; the meter is the screen. The confirm pane is
    // HIDDEN, not unmounted — the old screen flipped `hidden` on both panes.
    const confirmPane = [...document.querySelectorAll(".reset-view > div")].find((d) =>
      d.textContent?.includes("Type this machine's hostname"),
    ) as HTMLElement | undefined;
    expect(confirmPane?.hidden).toBe(true);
    const rows = document.querySelectorAll("ul.checklist li");
    expect(rows).toHaveLength(5);
    // "active" is the checklist's own vocabulary for a running row.
    expect(rows[0].getAttribute("data-state")).toBe("active");
    expect(rows[1].getAttribute("data-state")).toBe("done");
    expect(rows[2].getAttribute("data-state")).toBe("pending");
  });

  it("marks a failed row with the checklist's cross, and promotes the run label to Retry", () => {
    renderReset({
      steps: { ...emptySteps(), plan: "done", stop: "failed" },
      runLabel: "Retry reset",
      log: { text: "launchctl bootout exited 5", bad: true },
    });
    const rows = document.querySelectorAll("ul.checklist li");
    expect(rows[1].getAttribute("data-state")).toBe("failed");
    expect(rows[1].textContent).toContain("✕");
    // The half-run's verbatim log, reading as a failure.
    const log = document.querySelector("pre.pane-pre.mt-3") as HTMLPreElement;
    expect(log.textContent).toBe("launchctl bootout exited 5");
    expect(log.className).toContain("output-bad");
    expect(screen.getByRole("button", { name: "Retry reset" })).toBeDefined();
  });

  it("hides the log while it says nothing, and shows the busy states while the chain runs", () => {
    renderReset({ busy: true, log: { text: "", bad: false } });
    expect((document.querySelector("pre.pane-pre.mt-3") as HTMLPreElement | null)?.hidden ?? true).toBe(true);
    expect(screen.getByRole("button", { name: "Resetting…" })).toBeDefined();
    // Cancel reads as "cancel this reset" under the meter, which is the one
    // thing it cannot do: disabled while the chain runs.
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
  });

  it("hands the cancel to the page's own close", () => {
    const onCancel = vi.fn();
    const _view = renderReset({ onCancel });
    screen.getByRole("button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
