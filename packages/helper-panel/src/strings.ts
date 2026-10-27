import type { PanelState, StateValue } from "./state";

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
  enable: "Enable helper",
  disable: "Disable helper",
  enableNote: "Disabling stops capture and input. Your subshells and macOS permissions stay.",
  loginItemPending: "Needs approval in System Settings under Login Items.",
  loginItemRegistered: "Starts at sign-in with macOS.",
  loginItemLabel: "Login item",
  openLoginItems: "Open login items…",
  openDocs: "Setup instructions",
  minimize: "Minimize helper",
  quit: "Quit helper",
  /* The confirmation names the action, then the body says what stops, what
   * stays, and how to get back in. Quitting also unregisters the login item's
   * running copy, so "it comes back" is the fact a person needs most and the
   * one a silent quit would never tell them. */
  quitTitle: "Quit the display helper?",
  quitBody:
    "Anyone watching a virtual display on this Mac loses it now. Your consent and the macOS permissions stay, and the helper starts again at sign-in, or sooner from Subshell's virtual display settings. To stop it coming back, disable it first.",
  cancel: "Cancel",
  /* What the button says, and what it says to a screen reader. The visible
   * label is one word because the row already names the permission; the
   * accessible name has to stand alone in a list of controls, where two
   * buttons called "Allow" would be indistinguishable. */
  allow: "Allow",
  requestCapture: "Allow screen recording",
  requestInput: "Allow accessibility",
  permissionNeedsConsent: "Enable the helper before requesting macOS permissions.",
} as const;

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
 * The login item's own line, shown only while the helper is enabled: a person
 * who turned it off has not registered anything to approve. Registered is a
 * settled fact and reads in the page's own ink; awaiting macOS is the thing
 * still waiting on them, so it reads in gold, the same split the permission
 * rows use.
 */
export function loginItemLine(needsApproval: boolean): StateValue {
  return needsApproval
    ? { text: strings.loginItemPending, blocked: true }
    : { text: strings.loginItemRegistered, blocked: false };
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
