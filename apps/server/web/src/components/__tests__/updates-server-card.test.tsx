import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { idleUpdate, recordingUpdate, serverUpdateView } from "@/components/__tests__/helpers/updates-view";
import { jobLine, ServerCard } from "@/components/updates/server-card";
import type { ServerUpdateView, UpdateJob } from "@/types/updates";

afterEach(cleanup);

const updateButton = (label = /^Update to /) => screen.getByRole("button", { name: label }) as HTMLButtonElement;

function renderCard(view: ServerUpdateView, update = idleUpdate) {
  return render(<ServerCard view={view} update={update} onCheck={() => {}} checking={false} serverVersion="0.6.0" />);
}

/** The job, at one phase, with everything else at a resting value. */
function job(over: Partial<UpdateJob> = {}): UpdateJob {
  return {
    from: "0.6.0",
    to: "0.7.0",
    startedAt: "2026-09-15T10:00:00.000Z",
    phase: "downloading",
    received: 0,
    total: null,
    error: null,
    ...over,
  };
}

describe("the three states of the Server card", () => {
  it("offers the update, names the backup, and promises the panes", () => {
    renderCard(serverUpdateView());
    expect(screen.getByText("0.7.0 is available. Running 0.6.0.")).toBeTruthy();
    expect(updateButton().disabled).toBe(false);
    expect(screen.getByText(/backed up to/)).toBeTruthy();
    expect(screen.getByText(/5 kept/)).toBeTruthy();
    expect(screen.getByText(/open subshells keep running/)).toBeTruthy();
  });

  it("says it is the newest release rather than disabling a button with no explanation", () => {
    renderCard(
      serverUpdateView({
        updateAvailable: false,
        latest: { version: "0.6.0", tag: "server-v0.6.0", publishedAt: null },
      }),
    );
    expect(screen.getByText("Running 0.6.0 — the newest release.")).toBeTruthy();
    expect(updateButton().disabled).toBe(true);
  });

  it("lists every blocker the server named, and disables the button", () => {
    // `canApply.reasons` is the server's own union, so the page can never
    // offer what the route will refuse.
    renderCard(
      serverUpdateView({
        canApply: {
          ok: false,
          reasons: ["this server is not running under a service manager", "this server runs from a checkout"],
        },
      }),
    );
    expect(
      screen.getByText(/Updates are unavailable: this server is not running under a service manager\./),
    ).toBeTruthy();
    expect(screen.getByText(/Updates are unavailable: this server runs from a checkout\./)).toBeTruthy();
    expect(updateButton().disabled).toBe(true);
  });

  it("distinguishes a source that is OFF from one that could not be read", () => {
    // The first is a configuration; the second is a host that could update and
    // could not find out whether it should. Only the first is a blocker.
    const off = renderCard(
      serverUpdateView({
        source: { url: null, enabled: false },
        latest: null,
        updateAvailable: false,
        canApply: { ok: false, reasons: ["no release source is configured (SUBSHELL_RELEASE_URL is empty)"] },
      }),
    );
    expect(screen.getByText(/no release source is configured/)).toBeTruthy();
    expect(screen.queryByText(/Could not check/)).toBeNull();
    off.unmount();

    renderCard(serverUpdateView({ latest: null, updateAvailable: false, latestError: "api.github.com answered 503" }));
    expect(screen.getByText(/Could not check for updates: api.github.com answered 503\./)).toBeTruthy();
  });

  it("warns about panes instead of promising them, when the definition would kill them", () => {
    renderCard(serverUpdateView({ paneSafety: "kills" }));
    expect(screen.getByText(/would close every running subshell/)).toBeTruthy();
  });
});

describe("the job", () => {
  it("speaks one line per phase, with the download's own progress", () => {
    expect(jobLine(job({ received: 42_000_000, total: 81_000_000 }))).toBe("Downloading 0.7.0 (42 of 81 MB)…");
    // A release source that sent no content length still says something true.
    expect(jobLine(job({ received: 42_000_000 }))).toBe("Downloading 0.7.0 (42 MB)…");
    expect(jobLine(job({ phase: "verifying" }))).toBe("Verifying…");
    expect(jobLine(job({ phase: "backing-up" }))).toBe("Backing up the database…");
    expect(jobLine(job({ phase: "swapping" }))).toBe("Installing…");
    expect(jobLine(job({ phase: "restarting" }))).toBe("Restarting…");
  });

  it("renders the running phase and locks the button, even in a tab that did not press it", () => {
    // The job is a fact about the SERVER, so an admin who reloads mid-update
    // — or a second admin watching — must see it, with `outcome` still idle.
    renderCard(serverUpdateView({ job: job({ phase: "backing-up" }) }));
    expect(screen.getByText("Backing up the database…")).toBeTruthy();
    expect(updateButton().disabled).toBe(true);
  });

  it("reports a failure that reverted at boot, which no tab's own outcome holds", () => {
    renderCard(
      serverUpdateView({
        lastFailure: {
          from: "0.6.0",
          to: "0.7.0",
          binary: "/b",
          previousBinary: "/b.previous",
          backup: "/c/backups/x.db",
          startedAt: "2026-09-15T10:00:00.000Z",
          origin: "cli",
          error: "corrupted migrations",
          failedAt: "2026-09-15T10:01:00.000Z",
        },
      }),
    );
    expect(screen.getByText(/The update to 0.7.0 failed and 0.6.0 was restored: corrupted migrations/)).toBeTruthy();
  });
});

describe("the confirmation", () => {
  it("presses without force on a pane-safe host", () => {
    const update = recordingUpdate();
    renderCard(serverUpdateView(), update);
    fireEvent.click(updateButton());
    fireEvent.click(screen.getByRole("button", { name: "Update to 0.7.0" }));
    expect(update.pressed).toEqual([{}]);
  });

  it("offers the forced path — and only the forced path — where the definition kills panes", () => {
    const update = recordingUpdate();
    renderCard(serverUpdateView({ paneSafety: "unknown" }), update);
    fireEvent.click(updateButton());
    // "unknown" is not "keeps": a definition nobody could read is warned about
    // rather than promised, the same gate `RestartDialog` applies.
    fireEvent.click(screen.getByRole("button", { name: "Update anyway" }));
    expect(update.pressed).toEqual([{ force: true }]);
  });
});
