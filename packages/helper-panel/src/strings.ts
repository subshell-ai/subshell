import type { LoginItemState, PanelAction, PanelState, StateValue } from "./state";

/**
 * Every word the panel shows, in one file. The copy is the interface: a
 * consent surface that does not say plainly what it enables has not asked for
 * consent. Keeping it pure is also what makes it testable without a web view.
 */
export const strings = {
  title: "Subshell virtual display helper",
  subtitle: "Capture and control of Subshell's virtual displays on this Mac.",
  warning:
    "macOS shares one desktop: a viewer's pointer is the real cursor, and other windows can appear in the stream. Enable this only for people you trust to control this Mac.",
  access: "Access",
  /* Its own section, not a row under Access: whether the helper comes back
   * after a sign-in is macOS's launch bookkeeping, a different question from
   * whether the person has agreed to be captured. The heading is also what
   * lets the enable note below stop claiming the fact twice. */
  signInSection: "Launch at sign-in",
  permissions: "macOS permissions",
  /* The sign-in choice is the person's own, so each state offers the one act
   * that changes it: register, stop registering, or go where macOS is waiting
   * for approval. Enabling the helper never registers anything by itself. */
  startAtSignIn: "Start at sign-in",
  stopAtSignIn: "Stop at sign-in",
  loginItemPending: "Needs approval in System Settings under Login Items.",
  loginItemRegistered: "Starts at sign-in with macOS.",
  /* No advice about toggling consent: the button beside this row registers it,
   * and enabling the helper no longer does, so sending the person to disable
   * and re-enable would be a detour to the same act. */
  loginItemMissing: "Not registered, so it will not start at sign-in.",
  loginItemLabel: "Login item",
  openLoginItems: "Open login items…",
  openDocs: "Setup instructions",
  minimize: "Minimize helper",
  quit: "Quit helper",
  /* The confirmation's shape. Its body is `quitBody` below, because what the
   * helper does after a sign-in depends on a state the panel can already see. */
  quitTitle: "Quit the display helper?",
  cancel: "Cancel",
  /* What the button says, and what it says to a screen reader. The visible
   * label is one word because the row already names the permission; the
   * accessible name has to stand alone in a list of controls, where two
   * buttons called "Allow" would be indistinguishable. */
  allow: "Allow",
  requestCapture: "Allow screen recording",
  requestInput: "Allow accessibility",
  /* The granted rows keep a control. What they cannot do is offer the prompt
   * again: macOS has nothing left to ask, so a press would look like a hang.
   * This opens the pane where the grant lives, and the ellipsis is honest
   * because another app is about to take over. */
  openSettings: "Open settings…",
  openCaptureSettingsLabel: "Open screen recording settings",
  openInputSettingsLabel: "Open accessibility settings",
  permissionNeedsConsent: "Enable the helper before requesting macOS permissions.",
  /* The two row labels name macOS's own panes, so they read the way System
   * Settings reads. They live here for the same reason as everything else the
   * page says: a word kept outside this file is a word no wording review, voice
   * check, or parity test ever sees. */
  capturePermissionLabel: "Screen recording",
  inputPermissionLabel: "Accessibility",
} as const;

/**
 * The consent button's label and its sentence, per state.
 *
 * Deliberately NOT members of `strings` above. The defect these exist to prevent
 * is a page module taking the label and the note from different states, and a
 * property that lives on an exported object is a property any module can reach by
 * some spelling: `strings["enableNote"]`, `"disable" + "N" + "ote"`,
 * `Reflect.get`, `Object.values({...strings})[8]`. Round 22 chased those with
 * patterns and round 23 proved regexes cannot evaluate an escape. What nothing can
 * reach is what was never exported, so the four strings are module-private here
 * and `consentControl` is the only door through them. Both are `detail` text at
 * one size in muted ink (gold belongs to what the owner can still act on).
 */
const consentCopy = {
  enableLabel: "Enable helper",
  disableLabel: "Disable helper",
  enableNote:
    "Enabling starts capture and input on this Mac. Your subshells, macOS permissions, and sign-in choice stay.",
  disableNote: "Disabling stops capture and input. Your subshells, macOS permissions, and sign-in choice stay.",
};

/**
 * The consent control and the note that explains it, decided together.
 *
 * Both used to read `state.enabled` at their own site, three ternaries deep in
 * the render, and that is exactly how the pair got out of step: the button said
 * "Enable helper" while its own note said "Disabling stops capture and input",
 * so the sentence a screen reader announces for the act being refused was the
 * sentence for the opposite act. One call, one state read, no way to pair them
 * wrongly.
 */
export function consentControl(state: PanelState): { label: string; action: PanelAction; note: string } {
  return state.enabled
    ? { label: consentCopy.disableLabel, action: "disable", note: consentCopy.disableNote }
    : { label: consentCopy.enableLabel, action: "enable", note: consentCopy.enableNote };
}

/** The one-line answer to "is this machine exposing itself right now". */
export function stateLine(state: PanelState): string {
  if (!state.enabled) return "Disabled. Nothing is captured and no input is accepted.";
  return "Enabled. Capture and input also need both macOS permissions below.";
}

/** Gold while a viewer holds a screen, muted when nobody does. */
export function viewerLine(state: PanelState): string {
  if (state.viewers <= 0) return "No one is viewing a virtual display on this Mac.";
  return state.viewers === 1
    ? "A Subshell viewer is watching this Mac's virtual display right now."
    : `${state.viewers} Subshell viewers are watching this Mac's virtual displays right now.`;
}

/**
 * The login item's own line. Registered is a settled fact and reads in the
 * page's own ink; awaiting macOS is the thing still waiting on them, so it
 * reads in gold, the same split the permission rows use.
 */
export function loginItemLine(state: LoginItemState): StateValue {
  switch (state) {
    case "registered":
      return { text: strings.loginItemRegistered, blocked: false };
    case "needsApproval":
      return { text: strings.loginItemPending, blocked: true };
    case "notRegistered":
      return { text: strings.loginItemMissing, blocked: true };
  }
}

/**
 * Whether the **Launch at sign-in** section earns its heading. Consent is what
 * usually creates a registration, but it is not the only thing that keeps one:
 * disabling leaves the person's sign-in choice alone on purpose, and that row
 * holds the only button that takes it back off macOS's list. Hiding the section
 * with the consent toggle would strand a registered helper with no way to
 * unregister it short of enabling capture again.
 */
export function showsSignInSection(state: PanelState): boolean {
  return state.enabled || state.loginItem !== "notRegistered";
}

/**
 * The quit confirmation's body, which has to answer the sign-in question from
 * the state the panel already holds. Enabling never registered a login item and
 * disabling never removes one, so whether this process returns at the next
 * sign-in is a fact about that row, not a promise a dialog may make: saying
 * "it comes back at sign-in" to someone who never asked for it is how the
 * warning that exists to inform a decision ends up misleading instead. Every
 * variant names what stops, what stays, and how to get it back.
 */
const LOSS = "Anyone watching a virtual display on this Mac loses it now.";
const STAYS = "Your consent and the macOS permissions stay.";

/**
 * One whole sentence per reachable pair rather than a shared prefix, so the
 * helper's Swift copy can be compared to these literal for literal.
 *
 * The consent half matters as much as the registration half. A registered
 * helper that is switched off does come back at sign-in, and then exits
 * without capturing anything (`main.swift` terminates a consentless start), so
 * promising "it starts again at sign-in" to that person describes a return that
 * delivers no screen and sends them to a button they do not need. Naming the
 * state is what makes the sentence actionable in the right direction.
 */
const QUIT_BODIES: Record<LoginItemState, { enabled: string; disabled: string }> = {
  registered: {
    enabled: `${LOSS} ${STAYS} The helper starts again at sign-in, or sooner from Subshell's virtual display settings. To stop it coming back, use the panel's Stop at sign-in button first.`,
    disabled: `${LOSS} ${STAYS} The helper is disabled, so at sign-in it starts and exits without capturing anything. To take it out of macOS's login list, choose Stop at sign-in in the panel first.`,
  },
  needsApproval: {
    enabled: `${LOSS} ${STAYS} macOS is still waiting for your approval before it would start at sign-in, so it comes back when you open Subshell's virtual display settings.`,
    disabled: `${LOSS} ${STAYS} macOS is still waiting for your approval before it would start at sign-in, so it comes back when you open Subshell's virtual display settings.`,
  },
  notRegistered: {
    enabled: `${LOSS} ${STAYS} Nothing starts it at sign-in; it comes back when you open Subshell's virtual display settings.`,
    disabled: `${LOSS} ${STAYS} Nothing starts it at sign-in; it comes back when you open Subshell's virtual display settings.`,
  },
};

export function quitBody(loginItem: LoginItemState, enabled: boolean): string {
  return QUIT_BODIES[loginItem][enabled ? "enabled" : "disabled"];
}

/**
 * The state word, and whether it is something the person can still act on.
 * Gold is the design system's "the owner can fix this here"; white is a
 * settled fact. Reading both the same way is how an ungranted permission stops
 * being the thing to notice.
 */
export function permissionValue(granted: boolean): StateValue {
  return granted ? { text: "Allowed", blocked: false } : { text: "Not allowed", blocked: true };
}
