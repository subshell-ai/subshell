/**
 * The Reset confirmation, as the DIALOG it became on 2026-09-23 (operator
 * ruling; the Subshell Client's shape, ported): the refusal gate (an
 * incomplete paths block arms nothing), the hostname gate the page shares
 * with Rust, the two panes and their meter, and the action row's busy states.
 * What the modal adds to what the screen ruled: the dismissal (Cancel,
 * backdrop, Escape) is the way out until the chain runs, and INERT while it
 * runs — a running reset keeps its old room's rule that nothing ends it but
 * its own end.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { makeProbe } from "../../__tests__/harness";
import { emptySteps } from "../../lib/reset";
import { ResetDialog } from "../reset-dialog";

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
  return render(<ResetDialogHolder over={over} />);
}

function ResetDialogHolder(props: { over: Parameters<typeof renderReset>[0] }) {
  const over = props.over;
  const [typed, setTyped] = useState(over.typed ?? "");
  return (
    <ResetDialog
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

/** The confirm pane, found by its own question (the dialog hides panes, it
 *  does not unmount them — the same flip the old screen made on `hidden`).
 *  The LAST match is the deepest, the pane itself: every ancestor of it
 *  contains the question too, and `querySelectorAll` walks in document
 *  order. */
const confirmPane = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"] div')].findLast((d) =>
    d.textContent?.includes("Type this machine's hostname"),
  );

describe("the dialog and its gates", () => {
  it("is one labelled modal named for the act (RESET_LABEL)", () => {
    // "Reset this server" is RESET_LABEL, the dialog's own title. The rail
    // door carries the shorter "Reset" label (server-state.ts) — a different
    // string for the same act; this test pins only the dialog's aria name.
    renderReset({});
    expect(screen.getByRole("dialog", { name: "Reset this server" })).toBeDefined();
    expect(screen.getByRole("dialog", { name: "Reset this server" }).getAttribute("aria-modal")).toBe("true");
  });

  it("still renders its gate, refusing, when there is no probe at all", () => {
    // The guarantee the deleted route(null,"reset") pin used to hold: a deep
    // link can open the confirmation before any probe answers, and it must
    // render its refusal rather than a blank dialog or an armable button.
    renderReset({ probe: null });
    expect(screen.getByRole("dialog")).toBeDefined();
    expect((screen.getByRole("button", { name: "Reset everything" }) as HTMLButtonElement).disabled).toBe(true);
  });

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
    renderReset({});
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
    renderReset({ armingProblem: "The reset could not be staged: command not found." });
    expect(screen.getAllByText(/The reset could not be staged/).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Reset everything" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the run press and its meter", () => {
  it("fires only when armed, with the typed string", () => {
    const onRunReset = vi.fn();
    renderReset({ onRunReset });
    screen.getByRole("button", { name: "Reset everything" }).click();
    expect(onRunReset).not.toHaveBeenCalled(); // disabled: empty box
    typeHostname("testhost");
    screen.getByRole("button", { name: "Reset everything" }).click();
    expect(onRunReset).toHaveBeenCalledWith("testhost");
  });

  it("replaces the confirmation with the meter once the chain has touched anything, and retitles the pane", () => {
    renderReset({ steps: { ...emptySteps(), plan: "running", stop: "done" } });
    // The promises are gone; the meter is the pane. The confirm pane is
    // HIDDEN, not unmounted — the old screen flipped `hidden` on both panes.
    expect(confirmPane()?.hidden).toBe(true);
    const rows = document.querySelectorAll("ul.checklist li");
    expect(rows).toHaveLength(5);
    // "active" is the checklist's own vocabulary for a running row.
    expect(rows[0].getAttribute("data-state")).toBe("active");
    expect(rows[1].getAttribute("data-state")).toBe("done");
    expect(rows[2].getAttribute("data-state")).toBe("pending");
    // The title follows the pane, as the frame's did: the meter's own heading
    // while the chain runs.
    expect(screen.getByRole("dialog", { name: "Resetting this server" })).toBeDefined();
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
    // The Cancel survives into the dialog (the modal supersedes the
    // rail-is-the-exit ruling — the rail is unreachable under an overlay),
    // but nothing on the progress pane may offer an act the chain cannot
    // honour, so it is DISABLED, not gone.
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the modal's dismissal", () => {
  // The dialog's own refusal, and the section underneath is untouched — the
  // host owns that half (the close handler is this prop); here it is the press.
  it("hands the cancel to the host's close", () => {
    const onCancel = vi.fn();
    renderReset({ onCancel });
    screen.getByRole("button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("answers Escape when nothing is running", () => {
    const onCancel = vi.fn();
    renderReset({ onCancel });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("answers the backdrop, but not a press on the card itself", () => {
    const onCancel = vi.fn();
    renderReset({ onCancel });
    const card = screen.getByRole("dialog");
    fireEvent.click(card); // the island stops the event before the dismissal
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(card.parentElement as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("turns every dismissal inert while the chain runs", () => {
    const onCancel = vi.fn();
    renderReset({ busy: true, onCancel });
    fireEvent.keyDown(window, { key: "Escape" });
    const card = screen.getByRole("dialog").parentElement as HTMLElement;
    fireEvent.click(card);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
