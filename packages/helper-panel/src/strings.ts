import type { PanelState } from "./state";

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
  permissions: "macOS permissions",
  enable: "Enable helper",
  disable: "Disable helper",
  enableNote:
    "While enabled the helper runs in the background and starts at sign-in. Disabling stops capture and input; your subshells and macOS permissions stay.",
  openLoginItems: "Open login items…",
  openDocs: "Setup instructions…",
  minimize: "Minimize helper",
  quit: "Quit helper",
  requestCapture: "Allow screen recording…",
  requestInput: "Allow accessibility…",
  permissionNeedsConsent: "Enable the helper before requesting macOS permissions.",
} as const;

/** The one-line answer to "is anyone looking at this machine right now". */
export function stateLine(state: PanelState): string {
  if (!state.enabled) return "Disabled. Nothing is captured and no input is accepted.";
  const base = "Enabled. Capture and input also need both macOS permissions below.";
  return state.loginItemNeedsApproval
    ? `${base} Allow background startup in System Settings under General, Login Items so it resumes after you sign in.`
    : base;
}

/** Gold while a viewer holds a screen, muted when nobody does. */
export function viewerLine(state: PanelState): string {
  if (state.viewers <= 0) return "No one is viewing a virtual display on this Mac.";
  return state.viewers === 1
    ? "A Subshell viewer is watching this Mac's virtual display right now."
    : `${state.viewers} Subshell viewers are watching this Mac's virtual displays right now.`;
}

export function permissionLine(label: string, granted: boolean): string {
  return `${label}: ${granted ? "Allowed" : "Not allowed"}`;
}
