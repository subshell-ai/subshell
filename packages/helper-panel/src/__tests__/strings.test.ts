import { describe, expect, test } from "bun:test";
import { EMPTY_STATE, type PanelState } from "../state";
import { loginItemLine, permissionValue, stateLine, strings, viewerLine } from "../strings";

/**
 * The panel's copy is its consent interface, so the words are the behavior
 * under test: a line that overstates what is running (or hides that someone is
 * watching) leads a person to leave the helper on. Each assertion below names
 * the misreading it prevents.
 */
function stateWith(overrides: Partial<PanelState>): PanelState {
  return { ...EMPTY_STATE, ...overrides };
}

describe("the consent warning", () => {
  test("says plainly what enabling exposes, so the decision is informed", () => {
    // The defect this guards: a warning that reads like a generic privacy
    // notice, so someone enables capture without knowing a viewer drives the
    // real cursor and sees their other windows.
    const warning = strings.warning;
    expect(warning).toContain("pointer");
    expect(warning).toContain("real cursor");
    expect(warning).toContain("other windows");
    expect(warning).toContain("trust");
  });

  test("keeps every control label to the action it takes", () => {
    // "Minimize helper" once read as "stop the helper", so a person thought
    // capture had ended while it had not. The label names the window.
    expect(strings.minimize).toBe("Minimize helper");
    expect(strings.quit).toBe("Quit helper");
    expect(strings.enable).toBe("Enable helper");
    expect(strings.disable).toBe("Disable helper");
  });

  test("puts the ellipsis only where another app opens", () => {
    // macOS convention, and the dashboard's: "…" means a dialog or another
    // app is about to take over. System Settings does; the browser link and
    // the "Allow" buttons do not, because the row already names the permission.
    expect(strings.openLoginItems.endsWith("…")).toBe(true);
    for (const label of [strings.allow, strings.openDocs, strings.minimize, strings.quit]) {
      expect(label.endsWith("…")).toBe(false);
    }
  });
});

describe("stateLine", () => {
  test("denies both capture and input while disabled", () => {
    const line = stateLine(stateWith({ enabled: false, screenRecording: true, accessibility: true }));
    expect(line).toContain("Disabled");
    expect(line).toContain("Nothing is captured");
    expect(line).toContain("no input is accepted");
  });

  test("does not promise a working display while a permission is missing", () => {
    // Enabled alone is not enough: saying "Enabled and capturing" here would
    // tell someone their subshells have a screen when macOS still refuses.
    const line = stateLine(stateWith({ enabled: true }));
    expect(line).toContain("Enabled");
    expect(line).toContain("also need both macOS permissions");
  });

  test("keeps the state line to the state", () => {
    // The login item got its own row once the panel stopped being a report, so
    // the state line carries the permission facts only. Two sentences telling
    // one person the same thing in two places is how they start to disagree.
    const line = stateLine(stateWith({ enabled: true, loginItemNeedsApproval: true }));
    expect(line).toContain("Enabled");
    expect(line).not.toContain("Login Items");
  });
});

describe("loginItemLine", () => {
  test("names where to fix a login item macOS has not approved", () => {
    const pending = loginItemLine(true);
    expect(pending.text).toContain("System Settings");
    expect(pending.text).toContain("Login Items");
    expect(pending.blocked).toBe(true);
    const registered = loginItemLine(false);
    expect(registered.text).toContain("Starts at sign-in");
    expect(registered.text).not.toContain("Login Items");
    // White, not gold: a login item macOS already runs is not something the
    // person still has to fix, and gold is reserved for what they can act on.
    expect(registered.blocked).toBe(false);
  });
});

describe("enableNote", () => {
  test("says only what turning it off costs", () => {
    // The sign-in fact has its own section now. Saying it in two places is how
    // one of them ends up contradicting the other after the next change.
    expect(strings.enableNote).toContain("stops capture and input");
    expect(strings.enableNote.toLowerCase()).not.toContain("sign-in");
    expect(strings.enableNote.toLowerCase()).not.toContain("sign in");
  });
});

describe("viewerLine", () => {
  test("says nobody is watching when no capture is held", () => {
    expect(viewerLine(stateWith({ enabled: true, viewers: 0 }))).toContain("No one is viewing");
  });

  test("carries the count and agrees with it in number", () => {
    // A gold line reading "1 viewers" reads as a bug, and a person who stops
    // trusting the count stops reading it at all.
    const one = viewerLine(stateWith({ viewers: 1 }));
    expect(one).toContain("A Subshell viewer");
    expect(one).not.toContain("viewers are");
    const three = viewerLine(stateWith({ viewers: 3 }));
    expect(three).toContain("3");
    expect(three).toContain("viewers are");
  });
});

describe("permissionValue", () => {
  test("says the state, and marks the one the person can still act on", () => {
    // Gold for "Not allowed" and plain ink for "Allowed" is the whole point:
    // a settled fact must not compete for attention with the row that still
    // needs a click in System Settings.
    expect(permissionValue(true)).toEqual({ text: "Allowed", blocked: false });
    expect(permissionValue(false)).toEqual({ text: "Not allowed", blocked: true });
  });
});
