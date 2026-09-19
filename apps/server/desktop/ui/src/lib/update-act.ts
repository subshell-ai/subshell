/**
 * The one update act, decided (spec 2026-09-18 § 4, § 6, § 13).
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
 * app lands.)
 *
 * **It is a SELECTION, not always both halves** (§ 13, amended the same day).
 * An operator running the app at 0.8.1 with a `subshell-server` they had
 * updated by hand to 0.10.1 was told "it says subshell-server is older than the
 * currently running version": the CLI row was pushed whenever the app was
 * behind, and the subtitle promised "installing it also installs the server it
 * ships", while the ladder's answer was `adopt-installed` — so phase 2 would
 * have installed nothing. The act was never unsafe; the DISPLAY was false.
 * Every component the screen knows about therefore gets a row now, carrying a
 * checkbox where there is something to do and the REASON where there is not,
 * and one press runs what is ticked. With both halves behind, both are ticked
 * and one press does both, which is D1 unchanged.
 *
 * This file is that screen's whole decision: which rows to show, which of them
 * can act, what the press does and calls itself, what it refuses, and which of
 * the six phases the window is in.
 *
 * Pure, and therefore tested without a webview — which in this app is not a
 * preference but the only option: `ui/src/__tests__/` has no DOM harness, so a
 * judgment left in `wizard.ts` is a judgment with no coverage at all.
 */
import type { ActionResult, AppUpdateCheck, Probe } from "./ipc";
import { type PaneForce, paneForceBox } from "./pane-force";

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

/** The two components this screen knows about, and therefore the two rows. */
export type UpdateRowId = "app" | "cli";

/**
 * One line of the selection table: what a component runs, what it would become,
 * and either a checkbox or the reason there is none.
 */
export interface UpdateActRow {
  id: UpdateRowId;
  label: string;
  /** What is here now. */
  from: string;
  /**
   * What it moves to, or `null` when there is no number to state.
   *
   * Two different absences share the field, and {@link selected} tells them
   * apart. On a row that CAN act, `null` is the one number this build cannot
   * know: a desktop `release-manifest.json` carries the component version and
   * the asset digests, not the version of the CLI inside the bundle (§ 4.3),
   * so the screen says "the server it ships" and the number appears after the
   * relaunch. On a row that cannot act there is simply nothing it becomes.
   */
  to: string | null;
  /**
   * Ticked state, or `null` when this row has no act to offer.
   *
   * Selected by DEFAULT wherever it is not `null`: the default is the old
   * behaviour — everything actionable, one press (§ 13.1).
   */
  selected: boolean | null;
  /**
   * Why there is no checkbox, in the cell where the checkbox would be — never
   * a disabled checkbox, which says "not now" without saying anything (§ 13.1).
   * Short, because it is a table cell; the long form of a refusal is a
   * {@link UpdateAct.notes} sentence under the table.
   */
  reason: string | null;
}

/** The primary button, when there is one. */
export interface UpdateActPress {
  label: string;
  /**
   * Which half the press runs FIRST.
   *
   * `app` installs the application and relaunches; the CLI half then rides the
   * marker into the new build, and only when {@link bundled} says the person
   * asked for it. `cli` installs the bundled server and restarts the service
   * here and now — the whole act when the app is already current, and the
   * retry when phase 2 failed.
   */
  kind: UpdateRowId;
  enabled: boolean;
  /**
   * Whether the bundled CLI is installed as part of this press.
   *
   * On a `cli` press this is what the press IS. On an `app` press it decides
   * whether phase 1 writes the marker at all, which is how a deselected CLI row
   * survives the relaunch: the marker's presence is the selection, so there is
   * no second place for the two to disagree.
   */
  bundled: boolean;
  /**
   * Whether the pane-safety refusal is overruled for the restart this press
   * leads to — the Force box, already narrowed to the case where a definition
   * would actually refuse.
   */
  forced: boolean;
}

export interface UpdateAct {
  phase: UpdatePhase;
  /** The frame's subtitle: one sentence naming where this machine stands. */
  subtitle: string;
  rows: UpdateActRow[];
  press: UpdateActPress | null;
  /**
   * The long form of what this act will NOT do, and why — one sentence each,
   * rendered under the table (spec § 6). Never an error banner: an air-gapped
   * install and a service running someone else's binary are ordinary states of
   * a machine. The SHORT form of the same fact is the row's `reason`.
   */
  notes: string[];
  /**
   * The Force box, or `null` where nothing it governs is selected (§ 13.2).
   *
   * Its shape and its words are `lib/pane-force.ts`, shared with Server
   * Addresses, which restarts the same server through the same refusal. It is
   * offered only where the act, as selected, will restart a service whose
   * definition does not spare live panes — i.e. only where there is a refusal
   * to overrule — and it governs the pane-safety refusal and NOTHING else. In
   * particular it can never install an older bundled CLI over a newer
   * installed one — root `AGENTS.md`, "never downgrade the installed server":
   * boot runs `migrateToLatest()`, which is forward-only, so an older server
   * cannot boot on a database a newer one has migrated. That is a hard rule
   * rather than a scope decision, which is why the adopt-installed row states
   * it instead of offering a box.
   */
  force: PaneForce | null;
}

/**
 * What the person has ticked, held by the page.
 *
 * Page state rather than model state, because the model is pure: it is handed
 * the answer and decides the screen from it. Both fields are UNDER-specified on
 * purpose — an absent entry means "untouched", so a row whose default moves
 * with the machine underneath keeps moving until somebody touches it, and a
 * row that stops existing takes nothing with it.
 *
 * **An explicit answer, though, OUTLIVES the row within a visit** (review,
 * 2026-09-18 — the earlier wording implied otherwise). Untick a row, watch it
 * become unactionable, watch it come back, and it is still unticked. That is
 * the right behaviour and not merely the cheap one: the person said no to that
 * component, the machine changing under them is not them changing their mind,
 * and a tick silently restored by a poll would be the screen overruling them.
 * It is bounded by the visit — leaving the screen clears the selection.
 */
export interface UpdateActSelection {
  /** Rows the person toggled. An absent id takes the default, which is ticked. */
  rows: Partial<Record<UpdateRowId, boolean>>;
  /**
   * The Force box, once touched. `null` is untouched, and the default then
   * stands: unticked in phase 1, and in phase 2 the answer phase 1 recorded in
   * the marker — a consent already given is not asked for twice (§ 5).
   */
  force: boolean | null;
}

/**
 * Nothing ticked by hand: what a freshly opened screen is handed.
 *
 * Shared rather than constructed per visit, which is safe because every write
 * REPLACES it — `wizard.ts` spreads into a new object and never mutates these
 * two — and is what keeps "untouched" spelled once instead of at each door.
 */
export const NO_SELECTION: UpdateActSelection = { rows: {}, force: null };

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
  /** What the person has ticked. */
  selection: UpdateActSelection;
  /**
   * Whether an action is running in this window.
   *
   * The page's own `busy`, and it is NOT the same fact as {@link state}: that
   * one tracks the APP install's phases, which the CLI half never touches. So
   * a `subshell-server update --from` run — budgeted at 300 s — left the
   * primary button looking live for five minutes beside greyed checkboxes and
   * no progress line, which reads as a hung screen (review, 2026-09-18).
   * Subshell Client folds the same flag into its own `canPress`.
   */
  busy: boolean;
}

/** The screen's title — one act, one name, on every phase. */
/**
 * Whether the screen's way out must be held shut, because an install is
 * actually running behind it (review, 2026-09-18).
 *
 * The leave is `host.close()`, and on a ready machine that reaches
 * `openWhenReady` → `open_main`, which DESTROYS the assistant window. So
 * pressing it mid-install takes the progress, the failure line and the phase-2
 * screen with it, and the `app.restart()` that follows arrives explained by
 * nothing. The old screen gated its **Later** button for exactly this reason
 * and left **Not Now** — the same `host.close()` — ungated beside it.
 *
 * Two flags, and only two:
 *
 * - `busy` is the host's action-in-flight, set by `act()` around phase 2's
 *   install-and-restart.
 * - a `state` of `downloading` or `installing` is phase 1's app half. Only
 *   `downloading` is reachable from this screen today — nothing sets
 *   `installing` — but the union carries it, and a rule named for holding a
 *   window shut during an install must not be the thing that lets one
 *   through the day something does.
 *
 * A **check** deliberately does not gate: it is a bounded network read, and
 * leaving during one costs nothing. Neither flag can stick — `startAppUpdate`'s
 * catch resets the state and `act`'s `finally` clears `busy` — so a FAILED
 * install releases the button rather than stranding someone on a dead screen,
 * which is the trap a gate keyed on the phase (`finishing`) would have set.
 *
 * @param input - The two live flags the screen holds
 * @returns True while the leave must be inert
 */
export function leaveHeld(input: { busy: boolean; state: ActState }): boolean {
  return input.busy || input.state === "downloading" || input.state === "installing";
}

export const UPDATE_TITLE = "Update Subshell Server";

/** Where the bundled server is installed; a constant here, resolved in Rust. */
const INSTALL_PATH = "~/.local/bin/subshell-server";

/** The app's row label — "app", because the row under it is the binary. */
const APP_LABEL = "Subshell Server app";

/**
 * The CLI's row label.
 *
 * "CLI", and the binary's own name: this screen states TWO versions and
 * "Server" named neither of them unambiguously — it is the product's name as
 * much as the binary's, and the row above it is the app (operator's report,
 * 2026-09-18).
 */
const CLI_LABEL = "subshell-server CLI";

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

/**
 * Whether this machine runs a server NEWER than the one this app ships.
 *
 * The § 13 defect, named: the resolution ladder ADOPTS such a copy, so phase 2
 * answers "nothing left to do" and installs nothing — and a screen that pushed
 * the row anyway named a version older than the running one as a target.
 */
function cliOutranksBundle(probe: Probe): boolean {
  return probe.serverChoice === "adopt-installed";
}

/** Whether the bundled server is newer than what is installed, or nothing is. */
function cliBehind(probe: Probe): boolean {
  return probe.serverChoice === "upgrade-available" || probe.serverChoice === "install-bundled";
}

function cliFrom(probe: Probe): string {
  return probe.server?.version ?? "not installed";
}

/**
 * The § 6 sentence for a server this app did not install.
 *
 * One function because it is stated from TWO phases now: the offer, and the
 * phase-2 screen a marker written by an older build can still reach. A
 * refusal phrased differently in the two places would read as two different
 * facts about one machine.
 */
function refusalNote(probe: Probe): string {
  const path = probe.server?.argv[0] ?? "another location";
  return (
    `The server on this machine runs from ${path}, which this app did not install, so it is left alone. ` +
    `Only ${INSTALL_PATH} is replaced by an update from here.`
  );
}

/**
 * The § 13.2 sentence for a server newer than the bundle, and why no box.
 *
 * It names the supported way back rather than stopping at the refusal: moving
 * a server backwards is a real act, it just is not one a checkbox may perform,
 * because `subshell-server update --from <file>` takes the database backup
 * first and this screen cannot.
 */
function downgradeNote(probe: Probe): string {
  return (
    `This machine runs ${cliFrom(probe)} and this app ships ${probe.bundledVersion ?? "an older server"}. ` +
    "An older server cannot boot on a database a newer one has migrated, so nothing here will replace it — " +
    "`subshell-server update --from <file>` takes a database backup first and is the supported way back."
  );
}

/**
 * A rejection, as the result phase 2 needs it to be.
 *
 * `finishUpdate`'s two calls resolve with an `ActionResult` or REJECT — a
 * refusal that fired before anything ran, an IPC failure — and a rejection
 * used to leave `finished` null, which the screen reads as "nothing has been
 * attempted here". On the finishing phase that is a dead end: no Try Again,
 * and the automatic fire is latched for the visit, so the window sits under
 * "Installing the server it ships…" with an error line and no control
 * (review, 2026-09-18). A rejection is an attempt that failed, so it becomes
 * one, and the words still reach the problem line through `act`.
 */
export function rejectedResult(message: string): ActionResult {
  return { ok: false, stdout: "", stderr: message };
}

/**
 * The whole screen, from the machine, what this window has been doing, and what
 * the person has ticked.
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
 * 5. Otherwise the offer — the selection table.
 */
export function updateAct(input: UpdateActInput): UpdateAct {
  const { probe, appUpdate, state, finished, selection, busy } = input;
  const pending = probe?.pendingInstall ?? null;

  // 1. Finished here. Page state, because the success CLEARS the marker.
  if (finished?.ok === true) {
    // **It may only speak for what it installed** (review, 2026-09-18). The
    // sentence was unconditional, so a CLI-only press — the app row unticked —
    // ended on "both up to date" over an app a release behind. § 13 made this
    // a selection; the sentence that closes it has to read the selection too.
    const appStillBehind = appUpdate?.latest != null && appUpdate.latest !== appUpdate.current;
    return {
      phase: "done",
      subtitle: appStillBehind
        ? `The server on this machine is up to date. Subshell Server ${appUpdate.latest} is still available.`
        : "Subshell Server and the server it ships are both up to date.",
      rows: [],
      press: null,
      notes: [],
      force: null,
    };
  }

  // 2 and 3. Phase 2: an app update landed and its server has not been
  // installed yet. `halted` means the automatic attempts are spent, so the
  // screen stops firing by itself and says what happened.
  //
  // There is no SELECTION here, and that is not an omission: phase 2 is the
  // tail of a press already made, on one component, so the row states the act
  // rather than offering it. What the person may still answer is the Force
  // box, because a retry is a new consent.
  if (probe !== null && pending !== null) {
    // The refusal holds across the relaunch, and this is the only layer that
    // can SAY so. Rust keeps a marker from surviving on a machine whose server
    // this app does not manage — `resume_decision` is fed
    // `comparable_server_version`, which answers "nothing left to do" there —
    // but a marker written by an OLDER build predates that rule, and firing
    // under it would write `~/.local/bin` and restart a service running
    // someone else's binary, after a phase-1 screen that promised neither.
    // The install would report success, so the screen is where it can be
    // explained: the § 6 sentence, no press, and nothing fires.
    if (cliHalfRefused(probe)) {
      return {
        phase: "halted",
        subtitle: `Subshell Server was updated from ${pending.fromAppVersion}. The server on this machine is left alone.`,
        rows: [
          { id: "cli", label: CLI_LABEL, from: cliFrom(probe), to: null, selected: null, reason: "not this app's" },
        ],
        press: null,
        notes: [refusalNote(probe)],
        force: null,
      };
    }
    const failedHere = finished?.ok === false;
    // The marker carried phase 1's answer, so an untouched box shows it rather
    // than asking again for something already granted (§ 5).
    const force = paneForceBox(probe, true, selection.force ?? pending.forced);
    const retry: UpdateActPress = {
      label: "Try Again",
      kind: "cli",
      enabled: state === "idle" && !busy,
      bundled: true,
      forced: force?.checked === true,
    };
    // Phase 2 is where the CLI's target IS a number: this process is the new
    // bundle, so `bundledVersion` is the version § 4.3 could not state before
    // the relaunch. The row matters most on the halted screen, which is the
    // one that stops and has to say which install it means — the marker
    // records no reason of its own, so the versions are what it can state.
    const rows: UpdateActRow[] = [
      { id: "cli", label: CLI_LABEL, from: cliFrom(probe), to: probe.bundledVersion, selected: null, reason: null },
    ];
    if (pending.halted) {
      return {
        phase: "halted",
        subtitle: `Subshell Server was updated from ${pending.fromAppVersion}, but the server it ships could not be installed.`,
        rows,
        press: retry,
        notes: [
          "This machine is running the server it had before the update, which works. Nothing will try again on " +
            "its own until you press.",
        ],
        force,
      };
    }
    return {
      phase: "finishing",
      subtitle: `Subshell Server was updated from ${pending.fromAppVersion}. Installing the server it ships…`,
      rows,
      press: failedHere ? retry : null,
      notes: [],
      force: failedHere ? force : null,
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
      force: null,
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
      force: null,
    };
  }

  // 5. The offer, as a table. BOTH rows always, because a component the screen
  // knows about and does not state is a component the person has to guess at —
  // which is how "installing it also installs the server it ships" came to be
  // printed over a machine where it could not happen (§ 13).
  //
  // Subshell Client states the same rule and reaches this screen from a
  // different direction: it has an EMPTY table for "nothing is in question"
  // (its `upToDate` and `settled` are read from the row count), so what it
  // holds is that wherever there IS a table, every component is in it. The two
  // agreed in words and not in code until 2026-09-18 (review), when its agent
  // row could be dropped from a table its app row was already in.
  const notes: string[] = [];
  const appRow = offerAppRow(appUpdate, selection, notes);
  const cliRow = offerCliRow(probe, appRow.selected === true, selection, notes);
  const rows = [appRow, cliRow];

  const selectable = rows.filter((r) => r.selected !== null);
  const cliPicked = cliRow.selected === true;
  // An act that ran HERE and failed reaches this branch whenever the install
  // half landed and the RESTART did not: the marker is already cleared, the
  // machine reports nothing to install, and no row can act. Without the retry
  // the screen would offer no control at all and — worse — call the machine
  // current while it is still running the process it had (review,
  // 2026-09-18). Not offered where the CLI half is refused: there is nothing
  // for a retry to do there.
  const failedHere = finished?.ok === false;
  const retryable = failedHere && !cliHalfRefused(probe);
  // The act restarts the service only where the CLI half is part of it: an
  // app-only update leaves the running server exactly where it is. The retry
  // counts, and has to — it IS the restart that failed, so a screen offering it
  // without the box would offer the press and withhold the only answer that
  // makes it succeed.
  const force = paneForceBox(probe, cliPicked || (selectable.length === 0 && retryable), selection.force ?? false);
  const press = offerPress({
    appLatest: appRow.selected !== null ? appRow.to : null,
    appPicked: appRow.selected === true,
    cliPicked,
    anySelectable: selectable.length > 0,
    retryable,
    forced: force?.checked === true,
    state,
    busy,
  });

  return {
    phase: "idle",
    subtitle: subtitleForOffer(probe, appUpdate, appRow, cliRow, failedHere),
    rows,
    press,
    notes,
    // Only where the act will actually restart the service, and only where
    // something is left to press: a dead button has no consent to collect.
    force: press !== null ? force : null,
  };
}

/**
 * The app's row: what this build is, what the release list says it could be,
 * and — where it could be nothing — why.
 *
 * A failed check and an air-gapped source are two spellings of one answer here
 * ("we could not tell"), which is a different fact from "nothing newer exists"
 * and is why they get different cells.
 */
function offerAppRow(appUpdate: AppUpdateCheck | null, selection: UpdateActSelection, notes: string[]): UpdateActRow {
  const from = appUpdate?.current ?? "unknown";
  const latest = appUpdate?.latest ?? null;
  if (latest !== null) {
    return { id: "app", label: APP_LABEL, from, to: latest, selected: selection.rows.app ?? true, reason: null };
  }
  if (appUpdate === null || appUpdate.reason) {
    // A reason is not an error: an air-gapped install and a source that would
    // not answer are ordinary, and the screen still has the local half to
    // offer. The long form goes under the table; the cell stays a cell.
    if (appUpdate?.reason) notes.push(appUpdate.reason);
    return { id: "app", label: APP_LABEL, from, to: null, selected: null, reason: "could not check" };
  }
  return { id: "app", label: APP_LABEL, from, to: null, selected: null, reason: "up to date" };
}

/**
 * The CLI's row — the one § 13 was written about.
 *
 * `appRides` is whether the app half is actually GOING TO RUN — the app row
 * ticked, not merely tickable — and it changes what the CLI row MEANS rather
 * than merely whether it is shown: when the app is being replaced the server
 * that lands is the NEW bundle's, whose version this build cannot know
 * (§ 4.3), so the row's target is the sentence "the server it ships". When the
 * app is not being replaced the target is this bundle's own number, and there
 * is a row at all only if the CLI is genuinely behind.
 *
 * **Tickable was the wrong question, and answering it was destructive**
 * (review, 2026-09-18). With a behind app beside an up-to-date CLI, unticking
 * the app left this row ticked — because "the app CAN act" was still true —
 * and the press became `Update and Restart`. `subshell-server update --from`
 * prints "Already at X." and exits 0, so the install "succeeds" and the
 * service is restarted: on a definition that does not spare panes, every live
 * subshell on the machine closed for an install that changed nothing. Subshell
 * Client had this right from the start (`agentStandalone = agentAvailable &&
 * !appSelected`), which is what the two models being read against each other
 * found.
 *
 * What does NOT change with `appRides` is the refusals. A server this app did
 * not install stays untouched either way, and a server NEWER than the bundle
 * outranks it either way — that second one is the older defect: the row used
 * to be pushed unconditionally under a behind app, naming a version older than
 * the running one as a target.
 */
function offerCliRow(probe: Probe, appRides: boolean, selection: UpdateActSelection, notes: string[]): UpdateActRow {
  const from = cliFrom(probe);
  if (cliHalfRefused(probe)) {
    notes.push(refusalNote(probe));
    return { id: "cli", label: CLI_LABEL, from, to: null, selected: null, reason: "not this app's" };
  }
  if (cliOutranksBundle(probe)) {
    notes.push(downgradeNote(probe));
    return { id: "cli", label: CLI_LABEL, from, to: null, selected: null, reason: "you run a newer one" };
  }
  if (appRides) {
    return { id: "cli", label: CLI_LABEL, from, to: null, selected: selection.rows.cli ?? true, reason: null };
  }
  if (cliBehind(probe)) {
    return {
      id: "cli",
      label: CLI_LABEL,
      from,
      to: probe.bundledVersion,
      selected: selection.rows.cli ?? true,
      reason: null,
    };
  }
  return {
    id: "cli",
    label: CLI_LABEL,
    from,
    to: null,
    selected: null,
    reason: probe.bundledVersion === null ? "this app ships no server" : "up to date",
  };
}

/**
 * The button, named for what it will do.
 *
 * Dead rather than absent when a selection exists but nothing is ticked: the
 * table above it is the explanation, and a button that vanished as the last
 * box was cleared would make the screen jump under the hand that cleared it.
 * Absent where nothing can act at all, because there is then nothing to say.
 */
function offerPress(o: {
  appLatest: string | null;
  appPicked: boolean;
  cliPicked: boolean;
  anySelectable: boolean;
  retryable: boolean;
  forced: boolean;
  state: ActState;
  busy: boolean;
}): UpdateActPress | null {
  const enabled = o.state === "idle" && !o.busy;
  if (o.appPicked && o.appLatest !== null) {
    return {
      label: `Download and Install ${o.appLatest}`,
      kind: "app",
      enabled,
      // The marker is written only when the person asked for the server half,
      // which is how a cleared box survives the relaunch.
      bundled: o.cliPicked,
      forced: o.forced,
    };
  }
  if (o.cliPicked) {
    return { label: "Update and Restart", kind: "cli", enabled, bundled: true, forced: o.forced };
  }
  if (o.anySelectable) {
    return { label: "Update", kind: "app", enabled: false, bundled: false, forced: false };
  }
  if (o.retryable) {
    return { label: "Try Again", kind: "cli", enabled, bundled: true, forced: o.forced };
  }
  return null;
}

/**
 * The offer's one sentence.
 *
 * Split out because there are six of them and inlining a ternary that deep is
 * how a screen ends up saying "up to date" to a machine that has not been able
 * to check since it was installed — `latest` absent with a `reason` is "we
 * could not tell", which is a different fact from "nothing newer exists".
 *
 * It reads the ROWS rather than the probe wherever it can, which is what keeps
 * § 13's promise: the subtitle claimed "installing it also installs the server
 * it ships" from the app's version alone, over a machine whose CLI row could
 * not act. A sentence derived from the same rows the table renders cannot
 * diverge from it.
 */
function subtitleForOffer(
  probe: Probe,
  appUpdate: AppUpdateCheck | null,
  appRow: UpdateActRow,
  cliRow: UpdateActRow,
  failedHere: boolean,
): string {
  // Keyed on TICKED rather than on tickable, in BOTH halves: a row the person
  // cleared and a row that cannot act are the same fact to this sentence —
  // that half is not going to run — and promising it in either case is the
  // § 13 lie. The outer guard read `!== null` until 2026-09-18 (review), so an
  // unticked app row still produced "Subshell Server 0.8.1 is available.
  // Installing it also installs the server it ships." over a press that
  // installs no app at all.
  if (appRow.selected === true && appRow.to !== null) {
    return cliRow.selected === true
      ? `Subshell Server ${appRow.to} is available. Installing it also installs the server it ships.`
      : `Subshell Server ${appRow.to} is available. The server on this machine is not part of this update.`;
  }
  if (cliRow.selected !== null) {
    return `This app ships ${probe.bundledVersion ?? "a server"}; this machine runs ${probe.server?.version ?? "an unknown version"}.`;
  }
  // The act ran here and failed with nothing left to install, i.e. the install
  // landed and the restart did not. Saying "both current" there would be true
  // of the FILES and false of the machine, which is still running the server
  // it had — the one sentence a person would act on, phrased backwards.
  if (failedHere) {
    return "The server it ships is installed, but the restart did not finish — this machine is still running the server it had.";
  }
  if (appRow.reason === "could not check") {
    return "This app could not check for a newer version of itself.";
  }
  if (cliOutranksBundle(probe)) {
    return `Subshell Server is current, and this machine already runs a newer server than this app ships.`;
  }
  return `This app and the server it ships are both current${appUpdate?.current ? ` — Subshell Server ${appUpdate.current}` : ""}.`;
}
