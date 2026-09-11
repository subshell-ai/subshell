/**
 * The setup assistant's decisions, pure (spec 2026-09-11 § 5, § 8.1).
 *
 * Which screens exist for THIS machine, where the dots stand, which
 * checklist rows are ticked, whether Set Up may be pressed and why not, and
 * which of the CLI's words go under a failed row. Page state (the current
 * screen, running, the last result) stays in wizard.ts; only facts a probe
 * licenses live here, so a reopen after a quit or a CLI-driven half-setup
 * renders honestly.
 */
import type { ActionResult, Probe } from "./ipc";

/** The assistant's screens, in order. `tmux` exists only while tmux is missing. */
export type ScreenId = "welcome" | "tmux" | "setup";

/** Every position a dot can take, whether or not the screen is shown. */
const ALL_SCREENS: readonly ScreenId[] = ["welcome", "tmux", "setup"];

/** How the tmux screen presents itself when missing. */
export type PrereqState = "found" | "install" | "manual";

/** Where the press installs the server; rendered as a constant, resolved for real in Rust. */
const INSTALL_PATH = "~/.local/bin/subshell-server";

export function prereqState(probe: Probe): PrereqState {
  if (probe.tmux) return "found";
  if (probe.platform === "darwin") return probe.hasBrew ? "install" : "manual";
  return "install";
}

/** The screens this machine will actually see: a screen with nothing to ask does not appear. */
export function screensFor(probe: Probe): ScreenId[] {
  return ALL_SCREENS.filter((s) => s !== "tmux" || probe.tmux === null);
}

/**
 * Dot semantics: three positions always, so a machine that skips the tmux
 * screen sees its dot already filled rather than a shorter row. The SPA
 * continues this row (spec § 4): six dots in the desktop shell, three filled.
 */
export function dots(_probe: Probe, current: ScreenId): { total: 3; done: number; current: number } {
  const index = ALL_SCREENS.indexOf(current);
  return { total: 3, done: index, current: index };
}

export type SetupRowId = "tmux" | "server" | "config" | "service" | "running";

export interface SetupRow {
  id: SetupRowId;
  label: string;
  /** Muted right-hand text: a path, the addresses, or what "done" will mean. */
  detail: string;
  done: boolean;
}

/**
 * The Setting Up checklist, ticked from probe facts and never from the
 * chain's progress (optimism ticks a row the CLI then refuses). `addresses`
 * are the Customize form's current values, empty when untouched.
 */
export function setupRows(probe: Probe, addresses: { port: string; host: string }): SetupRow[] {
  const port = addresses.port || "3080";
  const host = addresses.host === "" || addresses.host === "0.0.0.0" ? "all interfaces" : addresses.host;
  return [
    { id: "tmux", label: "tmux", detail: probe.tmux ?? "", done: probe.tmux !== null },
    { id: "server", label: "Server", detail: probe.server?.argv[0] ?? INSTALL_PATH, done: probe.server !== null },
    {
      id: "config",
      label: "Configuration",
      detail: `port ${port}, ${host}`,
      done: probe.status?.configEnv?.exists === true,
    },
    { id: "service", label: "Background service", detail: "starts at login", done: probe.service?.installed === true },
    { id: "running", label: "Running", detail: "", done: probe.next === "ready" },
  ];
}

/**
 * Whether Set Up is live, and the reason beside it when not. An empty reason
 * means busy: a spinner is already on screen. The only machine gate is tmux
 * (`init` and `service install` both refuse without it); a missing server is
 * the chain's own first act.
 */
export function canSetup(probe: Probe | null, busy: boolean): { ok: true } | { ok: false; reason: string } {
  if (probe === null) return { ok: false, reason: "Checking this machine…" };
  if (busy) return { ok: false, reason: "" };
  if (probe.tmux === null) return { ok: false, reason: "Waiting for tmux" };
  return { ok: true };
}

/** The one line under a failed row: the CLI's last word on stderr, else stdout's, else a fixed sentence. */
export function failureLine(result: ActionResult): string {
  const last = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
  return last(result.stderr) ?? last(result.stdout) ?? "Setup stopped.";
}
