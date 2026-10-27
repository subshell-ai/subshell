import { describe, expect, test } from "bun:test";
import { EMPTY_STATE, type PanelState } from "../state";
import {
  consentControl,
  loginItemLine,
  permissionValue,
  quitBody,
  showsSignInSection,
  stateLine,
  strings,
  viewerLine,
} from "../strings";

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

  test("keeps the words the page says in this file", async () => {
    // `strings.ts` opens by claiming to hold every word the panel shows, and the
    // two permission row labels sat in `main.ts` as literals, where no wording
    // review, voice check, or parity test looks. Copy that lives outside this
    // file can disagree with the buttons beside it and nothing notices.
    expect(strings.capturePermissionLabel).toBe("Screen recording");
    expect(strings.inputPermissionLabel).toBe("Accessibility");
    const source = await Bun.file(new URL("../main.ts", import.meta.url)).text();
    expect(source).toContain("strings.capturePermissionLabel");
    expect(source).toContain("strings.inputPermissionLabel");
    for (const label of ['"Screen recording"', '"Accessibility"']) {
      expect(source, `main.ts renders no copy of its own (${label})`).not.toContain(label);
    }
  });

  test("puts the ellipsis only where another app opens", () => {
    // macOS convention, and the dashboard's: "…" means a dialog or another
    // app is about to take over. System Settings does; the browser link and
    // the "Allow" buttons do not, because the row already names the permission.
    for (const label of [strings.openLoginItems, strings.openSettings]) {
      expect(label.endsWith("…")).toBe(true);
    }
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
    const line = stateLine(stateWith({ enabled: true, loginItem: "needsApproval" }));
    expect(line).toContain("Enabled");
    expect(line).not.toContain("Login Items");
  });
});

describe("loginItemLine", () => {
  test("tells the three macOS states apart instead of collapsing them", () => {
    // Turning the switch OFF in System Settings leaves the item NOT REGISTERED,
    // which is a different fact from "registered but awaiting approval". The
    // panel once read both as approved, so a disabled sign-in start kept
    // claiming it starts at sign-in.
    expect(loginItemLine("registered")).toEqual({ text: "Starts at sign-in with macOS.", blocked: false });
    const pending = loginItemLine("needsApproval");
    expect(pending.blocked).toBe(true);
    expect(pending.text).toContain("Login Items");
    const missing = loginItemLine("notRegistered");
    expect(missing.blocked).toBe(true);
    expect(missing.text).toContain("will not start at sign-in");
    // Enabling the helper no longer registers anything, so the sentence must
    // not send the person to toggle consent to get a sign-in start back. The
    // button beside the row does it.
    expect(missing.text.toLowerCase()).not.toContain("re-enable");
  });
});

describe("the consent button's note", () => {
  test("each note names the act its own button performs", () => {
    // One sentence served both states, so a screen reader reaching "Enable
    // helper" heard "Disabling stops capture and input", and the person
    // deciding whether this Mac may be captured has only that announcement to
    // decide from. `main.ts` picks by `state.enabled`; these two must not be
    // interchangeable.
    expect(strings.enable).toBe("Enable helper");
    expect(strings.disable).toBe("Disable helper");
    expect(strings.enableNote).toContain("Enabling starts capture and input");
    expect(strings.enableNote).not.toMatch(/Disabling/);
    expect(strings.disableNote).toContain("Disabling stops capture and input");
    expect(strings.disableNote).not.toMatch(/Enabling/);
  });

  test("neither note promises a sign-in start, and both say the rest stays", () => {
    // Enabling no longer registers anything by itself, and that choice has its
    // own row and control, so a second place claiming it is how the two start
    // to disagree. What genuinely stays belongs in both sentences.
    for (const note of [strings.enableNote, strings.disableNote]) {
      expect(note).not.toContain("starts at sign-in");
      expect(note).toContain("sign-in choice stay");
      expect(note).toContain("macOS permissions");
    }
  });

  test("the button, its action, and its note come from one decision", async () => {
    // Asserting that the two sentences differ tests `strings.ts`; the bug was in
    // how the panel PAIRED them, so a future edit handing "Enable helper" the
    // disabling sentence would have left every string test green. One call now
    // returns the triple, and the page has nothing left to get wrong on its own.
    expect(consentControl(stateWith({ enabled: false }))).toEqual({
      label: "Enable helper",
      action: "enable",
      note: strings.enableNote,
    });
    expect(consentControl(stateWith({ enabled: true }))).toEqual({
      label: "Disable helper",
      action: "disable",
      note: strings.disableNote,
    });
    // The page draws the pair from that one call, rather than reading
    // `state.enabled` a second time beside the note.
    const source = await Bun.file(new URL("../main.ts", import.meta.url)).text();
    expect(source).toContain("consentControl(state)");
    expect(source).not.toMatch(/state\.enabled\s*\?\s*strings\.(disable|enable)Note/);
    expect(source).not.toMatch(/state\.enabled\s*\?\s*strings\.(disable|enable)\b/);
  });

  test("offers the sign-in act that matches the state it leaves", () => {
    // Two verbs, one per direction, plus the setting that waits for approval.
    expect(strings.startAtSignIn).toBe("Start at sign-in");
    expect(strings.stopAtSignIn).toBe("Stop at sign-in");
    expect(strings.openLoginItems.endsWith("…")).toBe(true);
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

describe("quit confirmation", () => {
  test("says what stops and what stays, in every sign-in state", () => {
    // Quitting ends every screen being watched and the window does not come
    // back on its own, so the act needs the consequences in front of the
    // person BEFORE they take it, not in the docs after.
    expect(strings.quitTitle.endsWith("?")).toBe(true);
    expect(strings.quitTitle).toContain("Quit");
    for (const state of ["registered", "needsApproval", "notRegistered"] as const) {
      for (const enabled of [true, false]) {
        const body = quitBody(state, enabled);
        expect(body).toContain("loses it now");
        expect(body).toContain("consent");
        // Every variant also has to say how the helper comes back: the sign-in
        // list, or the settings screen that launches it. A sentence that
        // mentions neither leaves the person guessing whether quitting is
        // recoverable, which is the question the dialog exists to answer.
        expect(body.includes("virtual display settings") || body.includes("login list")).toBe(true);
      }
    }
  });

  test("promises a sign-in return only to the person who asked for one and switched it on", () => {
    // Two halves decide the sentence. Enabling never registered a login item
    // and disabling never removes one, so "registered" is its own choice; and a
    // registered helper that is switched off does launch at sign-in, then exits
    // without capturing anything, so "it starts again at sign-in" describes a
    // return that delivers no screen. Only one pair may claim it.
    const ready = quitBody("registered", true);
    expect(ready).toContain("starts again at sign-in");
    expect(ready).toContain("Stop at sign-in");
    expect(ready).not.toContain("disable it first");
    const disabled = quitBody("registered", false);
    expect(disabled).toContain("without capturing anything");
    expect(disabled).toContain("Stop at sign-in");
    expect(disabled).not.toContain("starts again at sign-in");
    for (const state of ["needsApproval", "notRegistered"] as const) {
      for (const enabled of [true, false]) {
        expect(quitBody(state, enabled)).not.toContain("starts again at sign-in");
      }
    }
    expect(quitBody("notRegistered", true)).toContain("Nothing starts it at sign-in");
    expect(quitBody("needsApproval", true)).toContain("waiting for your approval");
  });

  test("gives the granted row a control that says where it goes", () => {
    // "Allow" twice would promise a prompt macOS has already answered, and a
    // bare "Settings" would not say which pane the press opens.
    expect(strings.openSettings).toBe("Open settings…");
    expect(strings.openCaptureSettingsLabel).toBe("Open screen recording settings");
    expect(strings.openInputSettingsLabel).toBe("Open accessibility settings");
  });

  test("names the same act in the button, the heading, and the confirm", () => {
    // A dialog that says "Close" over a button that said "Quit" is how a person
    // ends up unsure which thing they just did.
    expect(strings.quit).toBe("Quit helper");
    expect(strings.quitTitle.startsWith("Quit")).toBe(true);
  });
});

describe("showsSignInSection", () => {
  test("keeps the unregister door reachable while the helper is off", () => {
    // The row holds the only Stop at sign-in button, and disabling leaves the
    // registration in place on purpose. Hiding the section with the consent
    // toggle strands a registered helper: the person would have to accept
    // capture again to take it off macOS's list.
    expect(showsSignInSection(stateWith({ enabled: false, loginItem: "registered" }))).toBe(true);
    expect(showsSignInSection(stateWith({ enabled: false, loginItem: "needsApproval" }))).toBe(true);
    expect(showsSignInSection(stateWith({ enabled: false, loginItem: "notRegistered" }))).toBe(false);
    // Enabled is where the choice gets made, whatever the registration says.
    expect(showsSignInSection(stateWith({ enabled: true, loginItem: "notRegistered" }))).toBe(true);
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

describe("the menu's quit confirmation", () => {
  // The status menu asks the panel's question before ending the helper, in
  // Swift. Two copies of a consent sentence drift, and the drift is invisible
  // to both sides: the menu would quietly stop explaining what quitting costs
  // while the panel still did. Pin the menu's words to these.
  const swiftPath = new URL("../../../../native/display-helper/Theme.swift", import.meta.url);
  test("the native menu carries the same question and buttons", async () => {
    // Whitespace collapsed, so a re-wrapping on either side cannot fail a check
    // that is about the words.
    const swift = (await Bun.file(swiftPath).text()).replace(/\s+/g, " ");
    for (const [name, value] of Object.entries({
      title: strings.quitTitle,
      confirm: strings.quit,
      cancel: strings.cancel,
    })) {
      expect(swift).toContain(`static let ${name} = ${JSON.stringify(value)}`);
    }
  }, 10_000);

  test("the native menu answers the sign-in question state by state, like the panel", async () => {
    // The bodies are the part that used to lie: one sentence for all three
    // states promised a sign-in return to people who never registered one. If
    // Swift's copy of a state's sentence drifts from this one, the menu warns
    // about a future the panel says will not happen.
    const swift = (await Bun.file(swiftPath).text()).replace(/\s+/g, " ");
    for (const state of ["registered", "needsApproval", "notRegistered"] as const) {
      for (const enabled of [true, false]) {
        expect(swift).toContain(JSON.stringify(quitBody(state, enabled)));
      }
    }
  }, 10_000);

  test("the panel's own strings keep the shape the alert depends on", () => {
    // The Swift side treats the first button as the safe one; an empty label
    // would hand Return to the destructive act.
    expect(strings.cancel).toBeTruthy();
    expect(strings.quit).not.toBe(strings.cancel);
  });
});

describe("the native chrome's palette", () => {
  // The helper still paints three colours by hand (its window ground, the
  // muted label, the watching gold). Their numbers live in Theme.swift as
  // oklch triples copied from packages/assistant/tokens.css, and a copy that
  // is only compared against itself proves nothing: an editor who moves
  // --warning in the shared file changes every web surface and leaves the
  // menu bar's gold behind, with every native check still green. This reads
  // both files, so that drift fails here.
  const themePath = new URL("../../../../native/display-helper/Theme.swift", import.meta.url);
  const tokensPath = new URL("../../../assistant/tokens.css", import.meta.url);
  test("the swift triples are the shared file's triples, token by token", async () => {
    const [swift, css] = await Promise.all([Bun.file(themePath).text(), Bun.file(tokensPath).text()]);
    const block = /static let tokens: [^=]+ = \[([\s\S]*?)\n {4}\]/.exec(swift)?.[1] ?? "";
    const native = new Map<string, string>();
    for (const match of block.matchAll(/"([a-z0-9-]+)": \(([\d.]+), ([\d.]+), ([\d.]+)\)/g)) {
      native.set(match[1] as string, `${match[2]} ${match[3]} ${match[4]}`);
    }
    // Both patterns take the whole shadcn name space, digits included
    // (`--chart-1`): a name either regex cannot spell is a row compared to
    // nothing, which is the same hole as a missed number.
    // Count the rows loosely as well. A strict parser that silently misses an
    // entry would otherwise certify the three it happened to read and let a
    // fourth added token drift from the shared file unchecked, which is the
    // exact failure this test exists to catch.
    const declared = [...block.matchAll(/"([a-z0-9-]+)"\s*:\s*\(/g)].map((match) => match[1] as string);
    expect(declared.sort()).toEqual([...native.keys()].sort());
    expect(native.size).toBeGreaterThan(0);
    for (const [name, triple] of native) {
      const declared = new RegExp(`--${name}: oklch\\(([^)]+)\\)`).exec(css);
      expect(declared, `packages/assistant/tokens.css declares --${name}`).not.toBeNull();
      // The shared file writes the same three numbers; whitespace is the only
      // thing allowed to differ.
      expect((declared as RegExpExecArray)[1]?.replace(/\s+/g, " ").trim()).toBe(triple);
    }
  }, 10_000);
});
