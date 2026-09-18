/**
 * The one update act, decided (spec 2026-09-18 § 4, § 6).
 *
 * There were two update screens here until 2026-09-18 — *Update Your Server*,
 * which installed the bundled `subshell-server`, and *Update Subshell Server*,
 * which replaced the `.app` and relaunched — and they were never two acts.
 * Every desktop bundle SHIPS the CLI it wraps, so the first was the tail of the
 * second: a person who updated the app met, on the next boot, a probe finding a
 * bundled server newer than the installed one, and was asked again. The names
 * differed by a possessive.
 *
 * So there is one screen, and it does both halves — separated only by the
 * relaunch that necessarily sits between them, because the app must be replaced
 * BEFORE the server it ships can be installed. (The reverse order installs the
 * OUTGOING bundle's copy and leaves the machine behind again the moment the new
 * app lands.) This file is that screen's whole decision: which rows to show,
 * what the press does, what it refuses, and which of the six phases the window
 * is in.
 *
 * Pure, and therefore tested without a webview — which in this app is not a
 * preference but the only option: `ui/src/__tests__/` has no DOM harness, so a
 * judgment left in `wizard.ts` is a judgment with no coverage at all.
 */
import type { AppUpdateCheck, Probe } from "./ipc";
import { paneRisk } from "./recovery-model";

/**
 * Where this window is in the act.
 *
 * `finishing`, `halted` and `done` are all PHASE 2 — the half that runs after
 * the relaunch, in a process that did not exist when the person pressed. They
 * are three states rather than one because the screen owes a different sentence
 * for each: still working, gave up trying by itself, and finished.
 */
export type UpdatePhase = "idle" | "checking" | "downloading" | "finishing" | "halted" | "done";

/** What the page itself is doing; everything else is a fact about the machine. */
export type ActState = "idle" | "checking" | "downloading" | "installing";

/** One "X → Y" line: what is behind, and what it moves to. */
export interface UpdateActRow {
  id: "app" | "cli";
  label: string;
  /** What is here now. */
  from: string;
  /**
   * What it moves to, or `null` when this build cannot know yet.
   *
   * The CLI's target is unknowable before the download whenever the app itself
   * is behind: a desktop `release-manifest.json` carries the component version
   * and the asset digests, not the version of the CLI inside the bundle (spec
   * § 4.3). The screen says "the server it ships" rather than inventing a
   * number, and the number appears after the relaunch.
   */
  to: string | null;
}

/** The primary button, when there is one. */
export interface UpdateActPress {
  label: string;
  /**
   * Which half the press runs.
   *
   * `app` installs the application and relaunches; the CLI half then rides the
   * marker into the new build. `cli` installs the bundled server and restarts
   * the service here and now — the whole act when the app is already current,
   * and the retry when phase 2 failed.
   */
  kind: "app" | "cli";
  enabled: boolean;
}

export interface UpdateAct {
  phase: UpdatePhase;
  /** The frame's subtitle: one sentence naming where this machine stands. */
  subtitle: string;
  rows: UpdateActRow[];
  press: UpdateActPress | null;
  /**
   * What this act will NOT do, and why — one sentence each, rendered under the
   * rows (spec § 6). Never an error banner: an air-gapped install and a service
   * running someone else's binary are ordinary states of a machine.
   */
  notes: string[];
  /**
   * Whether the restart this act performs closes live subshells, so the screen
   * warns before the press.
   *
   * It stays on the combined act rather than moving to a second confirmation:
   * the restart is step 2 of 2 now, and a consent asked after the relaunch
   * would be asked in a window nobody chose to open (spec § 5).
   */
  paneWarning: boolean;
}

export interface UpdateActInput {
  /** The machine, or `null` before the first probe answers. */
  probe: Probe | null;
  /** The release list's answer about the APP, or `null` while none has come back. */
  appUpdate: AppUpdateCheck | null;
  /** What the page is doing right now. */
  state: ActState;
  /**
   * The finishing install's own answer, once this window has one.
   *
   * Page state, and it has to be: the marker is cleared the moment the install
   * succeeds, so a screen reading the probe alone would forget what it had just
   * done between one poll and the next.
   */
  finished: { ok: boolean } | null;
}

/** The screen's title — one act, one name, on every phase. */
export const UPDATE_TITLE = "Update Subshell Server";

/** Where the bundled server is installed; a constant here, resolved in Rust. */
const INSTALL_PATH = "~/.local/bin/subshell-server";

/**
 * Whether the CLI half can run at all on this machine.
 *
 * `managed` is false when the service runs a binary somewhere other than
 * {@link INSTALL_PATH} — someone's own build, a system package, a path chosen
 * in the recovery screen. Installing over `~/.local/bin` would then change
 * nothing about what the service runs, which is an update that reports success
 * and does nothing (root `AGENTS.md`, "never write the installed binary by
 * convention"). A machine with NOTHING installed is not this case: there the
 * install is a first install, and the app owns what it writes.
 */
function cliHalfRefused(probe: Probe): boolean {
  return probe.server !== null && !probe.managed;
}

/** Whether the bundled server is newer than what is installed, or nothing is. */
function cliBehind(probe: Probe): boolean {
  return probe.serverChoice === "upgrade-available" || probe.serverChoice === "install-bundled";
}

function cliRow(probe: Probe, to: string | null): UpdateActRow {
  return {
    id: "cli",
    // "CLI", and the binary's own name: this screen states TWO versions and
    // "Server" named neither of them unambiguously — it is the product's name
    // as much as the binary's, and the row above is the app (operator's
    // report, 2026-09-18).
    label: "subshell-server CLI",
    from: probe.server?.version ?? "not installed",
    to,
  };
}

/**
 * The whole screen, from the machine and what this window has been doing.
 *
 * The phase order below is a PRECEDENCE, not a list, and each step is there
 * because the one under it would otherwise answer for a state it knows nothing
 * about:
 *
 * 1. **This window finished the job** — the marker is already gone, so nothing
 *    downstream can tell a completed act from one that never happened.
 * 2. **A marker is waiting** — phase 2 outranks every phase-1 question,
 *    including the release check, which is a third party's answer about an app
 *    that has just been replaced.
 * 3. **The page is mid-download**, which only phase 1 can be in.
 * 4. **The check is in flight** and has said nothing yet.
 * 5. Otherwise the offer.
 */
export function updateAct(input: UpdateActInput): UpdateAct {
  const { probe, appUpdate, state, finished } = input;
  const pending = probe?.pendingInstall ?? null;

  // 1. Finished here. Page state, because the success CLEARS the marker.
  if (finished?.ok === true) {
    return {
      phase: "done",
      subtitle: "Subshell Server and the server it ships are both up to date.",
      rows: [],
      press: null,
      notes: [],
      paneWarning: false,
    };
  }

  // 2 and 3. Phase 2: an app update landed and its server has not been
  // installed yet. `halted` means the automatic attempts are spent, so the
  // screen stops firing by itself and says what happened.
  if (probe !== null && pending !== null) {
    const failedHere = finished?.ok === false;
    const retry: UpdateActPress = { label: "Try Again", kind: "cli", enabled: state === "idle" };
    if (pending.halted) {
      return {
        phase: "halted",
        subtitle: `Subshell Server was updated from ${pending.fromAppVersion}, but the server it ships could not be installed.`,
        rows: [],
        press: retry,
        notes: [
          "This machine is running the server it had before the update, which works. Nothing will try again on " +
            "its own until you press.",
        ],
        paneWarning: paneRisk(probe),
      };
    }
    return {
      phase: "finishing",
      subtitle: `Subshell Server was updated from ${pending.fromAppVersion}. Installing the server it ships…`,
      rows: [],
      press: failedHere ? retry : null,
      notes: [],
      paneWarning: paneRisk(probe),
    };
  }

  if (state === "downloading" || state === "installing") {
    const version = appUpdate?.latest;
    return {
      phase: "downloading",
      subtitle: version
        ? `Downloading Subshell Server ${version}. This app restarts when it is installed.`
        : "Downloading the update. This app restarts when it is installed.",
      rows: [],
      press: null,
      notes: [],
      paneWarning: false,
    };
  }

  // 4. The check is the screen's first act, and it is a NETWORK read — the one
  // fact here that is not a probe of this machine.
  if (probe === null || (state === "checking" && appUpdate === null)) {
    return {
      phase: "checking",
      subtitle: "Checking for a newer version of Subshell Server…",
      rows: [],
      press: null,
      notes: [],
      paneWarning: false,
    };
  }

  // 5. The offer.
  const appLatest = appUpdate?.latest ?? null;
  const rows: UpdateActRow[] = [];
  const notes: string[] = [];
  const refused = cliHalfRefused(probe);
  if (appLatest !== null) {
    rows.push({ id: "app", label: "Subshell Server app", from: appUpdate?.current ?? "", to: appLatest });
    // The app half always brings a server with it, so the row is stated
    // whenever the app is behind — with no target number, since only the new
    // bundle knows which server it carries (§ 4.3).
    if (!refused) rows.push(cliRow(probe, null));
  } else if (!refused && cliBehind(probe)) {
    rows.push(cliRow(probe, probe.bundledVersion));
  }

  if (refused) {
    const path = probe.server?.argv[0] ?? "another location";
    notes.push(
      `The server on this machine runs from ${path}, which this app did not install, so it is left alone. ` +
        `Only ${INSTALL_PATH} is replaced by an update from here.`,
    );
  }
  // A reason is not an error: an air-gapped install and a source that would not
  // answer are ordinary, and the screen still has the local half to offer.
  if (appUpdate?.reason) notes.push(appUpdate.reason);

  const press =
    appLatest !== null
      ? { label: `Download and Install ${appLatest}`, kind: "app" as const, enabled: state === "idle" }
      : rows.length > 0
        ? { label: "Update and Restart", kind: "cli" as const, enabled: state === "idle" }
        : null;

  return {
    phase: "idle",
    subtitle: subtitleForOffer(probe, appUpdate, appLatest, rows.length > 0),
    rows,
    press,
    notes,
    // Only where the act will actually restart the service: an app-only update
    // on a machine whose server this app does not manage restarts nothing.
    paneWarning: press !== null && rows.some((row) => row.id === "cli") && paneRisk(probe),
  };
}

/**
 * The offer's one sentence.
 *
 * Split out because there are four of them and inlining a ternary that deep is
 * how a screen ends up saying "up to date" to a machine that has not been able
 * to check since it was installed — `latest` absent with a `reason` is "we
 * could not tell", which is a different fact from "nothing newer exists".
 */
function subtitleForOffer(
  probe: Probe,
  appUpdate: AppUpdateCheck | null,
  appLatest: string | null,
  anyRows: boolean,
): string {
  if (appLatest !== null) {
    return `Subshell Server ${appLatest} is available. Installing it also installs the server it ships.`;
  }
  if (anyRows) {
    return `This app ships ${probe.bundledVersion ?? "a server"}; this machine runs ${probe.server?.version ?? "an unknown version"}.`;
  }
  if (appUpdate?.reason) {
    return "This app could not check for a newer version of itself.";
  }
  return `This app and the server it ships are both current${appUpdate?.current ? ` — Subshell Server ${appUpdate.current}` : ""}.`;
}
