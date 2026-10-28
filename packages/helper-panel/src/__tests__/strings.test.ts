import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EMPTY_STATE, type PanelState } from "../state";
// The module's whole surface, pinned below. A namespace import rather than a
// dynamic one, because this repo forbids `await import()` everywhere a bundler has
// to see the target.
import * as copyModule from "../strings";
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

/**
 * The two consent sentences, spelled out here because the panel cannot name
 * them. `strings.ts` keeps them module-private so no page module can take the
 * label and the note from different states by any spelling, and `consentControl`
 * is the only door through them, for this file exactly as for the page. These
 * literals are what that door must hand back.
 */
const ENABLE_NOTE =
  "Enabling allows capture and input once both macOS permissions are granted. Your subshells keep running, and your macOS permissions and sign-in choice don't change.";
const DISABLE_NOTE =
  "Disabling disconnects viewers and stops capture and input. Your subshells keep running, and your macOS permissions and sign-in choice don't change.";
/** The triple while the helper is off, so the button offers to enable it. */
const offerEnable = consentControl(stateWith({ enabled: false }));
/** And while it is on, so the button offers to disable it. */
const offerDisable = consentControl(stateWith({ enabled: true }));

/**
 * The one module allowed to hold the panel's words, named by its path from the
 * PACKAGE root, which is where `pageCode` starts.
 */
const COPY_FILE = "src/strings.ts";
/**
 * Where the panel's own suites live, and their assertions quote the copy on
 * purpose. Pinned to that path, not to any directory named `__tests__`: a helper
 * under such a name is still shipped code if a page module imports it, and the ban
 * in `MUTATES_AN_OBJECT`'s companion catches that rather than excusing it.
 */
const TEST_DIR = "src/__tests__/";
/** Not source. The root is the package, so build output sits in the walk's way. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage"]);

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Turn the escapes a browser or a bundler will undo back into characters before
 * anything is compared. Round 27 found this by building the panel: a stylesheet
 * carrying `content: "En\61 ble helper"` squashes to `contentEn61blehelper`, which
 * contains no banned word, while vite's minifier decodes the escape and the shipped
 * page renders "Enable helper" from a file the ban called clean.
 */
function decodeEscapes(source: string): string {
  return (
    source
      .replace(/\\u\{[0-9a-fA-F]+\}/g, (m) => String.fromCodePoint(parseInt(m.slice(3, -1), 16)))
      .replace(/\\u[0-9a-fA-F]{4}/g, (m) => String.fromCodePoint(parseInt(m.slice(2), 16)))
      .replace(/\\x[0-9a-fA-F]{2}/g, (m) => String.fromCodePoint(parseInt(m.slice(2), 16)))
      // CSS ends a hex run with a space, which is not part of the character.
      .replace(/\\[0-9a-fA-F]{1,6}[ \t]?/g, (m) => String.fromCodePoint(parseInt(m.slice(1).trim(), 16)))
      .replace(/&#x[0-9a-fA-F]+;/g, (m) => String.fromCodePoint(parseInt(m.slice(3, -1), 16)))
      .replace(/&#\d+;/g, (m) => String.fromCodePoint(Number(m.slice(2, -1))))
  );
}

/**
 * Reduce both sides of a copy comparison to letters and digits, so the only thing
 * that has to match is the words themselves. Round 25 showed a plain substring check
 * was only as strong as its spelling, and round 26 showed even this was reachable: a
 * sentence carried as `["Disabling…", "Your subshells…"].join(" ")` survives a strip
 * of quotes and `+`, because the array's commas and brackets are punctuation too.
 * Case is kept, deliberately: lowercasing would match `state.accessibility` against
 * the banned label "Accessibility", and an identifier is not the panel showing a word.
 */
function squash(source: string): string {
  return decodeEscapes(source).replace(/[^A-Za-z0-9]/g, "");
}

/**
 * Every page source except the one file allowed to hold copy, comments stripped.
 *
 * A guard that reads only `main.ts` is satisfied by moving the defect into a second
 * module, and the repository's own file-size rule ("split past ~300-400 lines", and
 * `main.ts` is 351) pushes an editor straight into doing that, so the walk is
 * recursive. It starts at the PACKAGE root rather than `src/`, because round 25
 * found the reason: the document the webview actually loads is `index.html` beside
 * `package.json`, along with the `inline.ts` that composes the shipped file. Rooted
 * one level down, the sweep had never read the page's own shell, and a consent
 * sentence pasted there stayed green while the same text in `src/` failed.
 */
async function pageCode(dir: URL = new URL("../../", import.meta.url), prefix = ""): Promise<PageSource[]> {
  const found: PageSource[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = `${prefix}${entry.name}/`;
      // Build output and dependencies are skipped at the PACKAGE root, where they
      // actually live, and nowhere else: round 27 hid a shipped `src/dist/copy.json`
      // from the sweep by using a directory name that is only special at the top.
      if (child !== TEST_DIR && !(prefix === "" && SKIP_DIRS.has(entry.name)))
        found.push(...(await pageCode(new URL(`${entry.name}/`, dir), child)));
      continue;
    }
    // Stylesheets, the page shell, and every other shape the bundler takes: CSS
    // `content:`, HTML markup, and a JSON file imported as data all put words on this
    // same consent surface. Round 26 found the gap by asking what an editor crowded
    // out of a 351-line `main.ts` would naturally do, which is move the sentences into
    // a data file the sweep never opened. Root config JSON is swept too; it costs
    // nothing and the alternative is a rule about which files count, which is the
    // judgement this sweep has already been caught making twice.
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|css|html|json|svg|txt|md|toml)$/i.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    if (`${prefix}${entry.name}` === COPY_FILE) continue;
    // `dir` already names the directory it was recursed into, so the file URL is
    // built from the entry alone; the prefix belongs only to the reported name.
    const code = await Bun.file(new URL(entry.name, dir)).text();
    found.push({ file: `${prefix}${entry.name}`, code: withoutComments(code) });
  }
  return found;
}

type PageSource = { file: string; code: string };

/**
 * Every file under a directory, with no opinion about whether it counts as source.
 *
 * The sweep's extension filter is a judgement, and a judgement cannot double as the
 * evidence that it missed nothing, which is exactly how a `src/copy.json` stayed
 * invisible to both the walk and the list built from it. `SKIP_DIRS` applies at the
 * package root only, so a directory called `dist` inside `src/` is a file someone
 * shipped rather than build output the enumerator is allowed to ignore.
 */
function listShipped(dirAbs: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      if (base !== "" || !SKIP_DIRS.has(entry.name)) out.push(...listShipped(path.join(dirAbs, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * What this file enforces, and what it deliberately does not.
 *
 * Four checks carry the weight, and all four are about facts rather than spelling:
 * the consent strings are not on the exported copy object or in the module's export
 * set (closed sets, so a new way to reach the words has to be typed into a list);
 * no shipped file holds a consent sentence as its own text (the copy ban, squashed
 * so a sentence split across literals or rewrapped is still the same words); the
 * shell's title is the copy's title; and the panel's triple comes from one call to
 * `consentControl`.
 *
 * Rounds 22-25 spent four passes chasing patterns that tried to recognise every way
 * of naming or reaching a property, and every finding in those rounds was in the
 * pattern list, never in the product: escapes, concatenation, `Reflect.get`,
 * spreads, non-enumerable definitions, an aliased receiver. A regex cannot evaluate
 * a program, so those lists are not closed and are gone. What is left unpolicied,
 * said plainly so nobody reads more protection into it than exists: page code may
 * still call `consentControl` twice and cherry-pick `label` from one result and
 * `note` from another, because that is a call to the sanctioned door, not a name
 * this file can recognise. The one-decision check makes the slip less likely by
 * counting calls; it does not make it impossible.
 */

/**
 * A page module importing from a test directory.
 *
 * `pageCode` skips `src/__tests__`, which is right for the suites and wrong for a
 * helper file that happens to live under a directory named like one: if page code
 * imports it, it ships, and it can hold a consent sentence the sweep never reads.
 * This is the exemption's own plug, not a general rule about syntax. It names the
 * path rather than the `from` keyword, because round 26 shipped a side-effect
 * `import "./__tests__/evil.css";` straight past the anchored version, and a
 * stylesheet pulled in that way is exactly as rendered as one bound to a name.
 */
const IMPORTS_TEST_DIR = /["'`][^"'`]*__tests__\//;

/**
 * Words the page may not hold in its own source, however it obtained them.
 *
 * Making the notes unreachable closes reading them off an object, but a module can
 * still type the disabling sentence beneath its own enable button, which is the
 * mispairing this file exists to prevent and no access rule can see. Comparing the
 * sentences themselves is the check that does not care where they came from, so
 * the same test that stops a page restating "Screen recording" stops it restating
 * a consent note.
 */
const COPY_THE_PAGE_MAY_NOT_HOLD = [
  ENABLE_NOTE,
  DISABLE_NOTE,
  offerEnable.label,
  offerDisable.label,
  strings.capturePermissionLabel,
  strings.inputPermissionLabel,
];

describe("the consent warning", () => {
  test("says plainly what enabling exposes, so the decision is informed", () => {
    // The defect this guards: a warning that reads like a generic privacy
    // notice, so someone enables capture without knowing a viewer drives the
    // real cursor and sees their other windows.
    const warning = strings.warning;
    expect(warning).toContain("pointer");
    expect(warning).toContain("share your Mac login, keyboard focus, and pointer");
    expect(warning).toContain("other windows");
    expect(warning).toContain("trust");
  });

  test("keeps every control label to the action it takes", () => {
    // "Minimize helper" once read as "stop the helper", so a person thought
    // capture had ended while it had not. The label names the window.
    expect(strings.minimize).toBe("Minimize helper");
    expect(strings.quit).toBe("Quit helper");
    expect(offerEnable.label).toBe("Enable helper");
    expect(offerDisable.label).toBe("Disable helper");
  });

  test("keeps the words the page says in this file", async () => {
    // `strings.ts` opens by claiming to hold every word the panel shows, and the
    // two permission row labels sat in `main.ts` as literals, where no wording
    // review, voice check, or parity test looks. Copy that lives outside this
    // file can disagree with the buttons beside it and nothing notices.
    expect(strings.capturePermissionLabel).toBe("Screen recording");
    expect(strings.inputPermissionLabel).toBe("Accessibility");
    const files = await pageCode();
    expect(
      files.some((f) => f.file === "src/main.ts"),
      "the page still has a main.ts to check",
    ).toBe(true);
    // Asked of the whole sweep rather than of one filename, because the same
    // split that moves a row out of `main.ts` would otherwise fail a check that
    // is about where the words live, not about which module renders them.
    for (const token of ["capturePermissionLabel", "inputPermissionLabel"]) {
      expect(
        files.some((f) => f.code.includes(`.${token}`)),
        `a page module renders ${token} from strings.ts`,
      ).toBe(true);
    }
    // The ban on the page holding these words at all is the sweep test of its own,
    // so a failure there reads as "someone typed the words" rather than as a
    // question about which module renders them.
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
  test("acknowledges both permissions once macOS allows them", () => {
    expect(stateLine(stateWith({ enabled: true, screenRecording: true, accessibility: true }))).toBe(
      "Enabled. Capture and input are allowed by macOS.",
    );
  });

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
    expect(line).toContain("still require both macOS permissions");
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
    expect(loginItemLine("registered")).toEqual({ text: "Starts when you sign in to macOS.", blocked: false });
    const pending = loginItemLine("needsApproval");
    expect(pending.blocked).toBe(true);
    expect(pending.text).toContain("Login Items");
    const missing = loginItemLine("notRegistered");
    expect(missing.blocked).toBe(true);
    expect(missing.text).toContain("Won't start when you sign in");
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
    // decide from. `consentControl` picks by `state.enabled`; these two must not
    // be interchangeable.
    expect(offerEnable.label).toBe("Enable helper");
    expect(offerDisable.label).toBe("Disable helper");
    expect(offerEnable.note).toContain("Enabling allows capture and input once both macOS permissions are granted");
    expect(offerEnable.note).not.toMatch(/Disabling/);
    expect(offerDisable.note).toContain("Disabling disconnects viewers and stops capture and input");
    expect(offerDisable.note).not.toMatch(/Enabling/);
  });

  test("neither note promises a sign-in start, and both say the rest stays", () => {
    // Enabling no longer registers anything by itself, and that choice has its
    // own row and control, so a second place claiming it is how the two start
    // to disagree. What genuinely stays belongs in both sentences.
    for (const note of [offerEnable.note, offerDisable.note]) {
      expect(note).not.toContain("starts at sign-in");
      expect(note).toContain("sign-in choice don't change");
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
      note: ENABLE_NOTE,
    });
    expect(consentControl(stateWith({ enabled: true }))).toEqual({
      label: "Disable helper",
      action: "disable",
      note: DISABLE_NOTE,
    });
    // The page draws the pair from that one call, rather than reading
    // `state.enabled` a second time beside the note. Asked of the sweep rather
    // than of `main.ts`, so moving the call into a split module is not the
    // change that turns this green.
    const files = await pageCode();
    // One read of `state.enabled` is the rule, so the door gets used once: the
    // identifier may appear exactly twice in the whole page, once as the import
    // specifier and once as the call. Round 25 laundered it through a local wrapper,
    // `function consentPair(s) { return consentControl(s); }`, and called the wrapper
    // three times on different state, so a count of the CALL spelling saw one use
    // while the note came back from the opposite state. Returning the door's result
    // and aliasing the door are refused for that reason. A second consent control
    // would be a different design, and this count is where someone says so.
    const door = files.flatMap((f) => f.code.match(/\bconsentControl\b/g) ?? []);
    expect(door, "one import and one call; a second consent control is a design change").toHaveLength(2);
    const laundered: string[] = [];
    for (const { file, code } of files) {
      if (/\breturn\s+consentControl\s*\(/.test(code))
        laundered.push(`${file} returns the door's result from a helper`);
      if (/=\s*consentControl\b(?!\s*\()/.test(code)) laundered.push(`${file} aliases the door`);
    }
    expect(laundered).toEqual([]);
  });

  test("offers the sign-in act that matches the state it leaves", () => {
    // Two verbs, one per direction, plus the setting that waits for approval.
    expect(strings.startAtSignIn).toBe("Start at sign-in");
    expect(strings.stopAtSignIn).toBe("Stop at sign-in");
    expect(strings.openLoginItems.endsWith("…")).toBe(true);
  });
});

describe("the consent copy's reachability", () => {
  /**
   * Every word the panel may show, and nothing else.
   *
   * Round 23 took the consent strings off the exported object so no page module
   * could name them, and round 24 showed that a list of FORBIDDEN names cannot guard
   * that: it checked the old spellings (`enable`, `disable`) and stayed silent while
   * the same labels came back under their current ones (`enableLabel`,
   * `disableLabel`), which is the mispairing defect reintroduced with every test
   * green. A closed set has no such blind spot. Reaching for the copy means adding a
   * key to this list, and a key someone has to type is a decision made in the open.
   */
  const COPY_KEYS = [
    "access",
    "allow",
    "cancel",
    "capturePermissionLabel",
    "inputPermissionLabel",
    "loginItemLabel",
    "loginItemMissing",
    "loginItemPending",
    "loginItemRegistered",
    "minimize",
    "openCaptureSettingsLabel",
    "openDocs",
    "openInputSettingsLabel",
    "openLoginItems",
    "openSettings",
    "permissionNeedsConsent",
    "permissions",
    "quit",
    "quitTitle",
    "requestCapture",
    "requestInput",
    "signInSection",
    "startAtSignIn",
    "stopAtSignIn",
    "subtitle",
    "title",
    "warning",
  ];
  /** The copy module's whole surface: helpers that decide wording, never the pair. */
  const MODULE_EXPORTS = [
    "consentControl",
    "loginItemLine",
    "permissionValue",
    "quitBody",
    "showsSignInSection",
    "stateLine",
    "strings",
    "viewerLine",
  ];

  test("the copy object holds exactly the words it is meant to hold", () => {
    // `Reflect.ownKeys`, not `Object.keys`: a property defined with
    // `enumerable: false` is invisible to the latter, and `Object.defineProperty`
    // inside this very module (which the page sweep exempts) is how a consent note
    // could come back while the closed set below still read 27 keys.
    expect(Reflect.ownKeys(strings).map(String).sort()).toEqual([...COPY_KEYS].sort());
  });

  test("the module exports no way past the one door", () => {
    // The same argument one level up, and invisible to the check above: what makes
    // the consent pair unreachable is `consentCopy` being module-private, and
    // writing `export` in front of it changes nothing about `strings`.
    expect(Object.keys(copyModule).sort()).toEqual([...MODULE_EXPORTS].sort());
  });

  test("the door still hands back the private pair", () => {
    // Which is what keeps the two closed sets above from being satisfied by simply
    // deleting the copy.
    expect(consentControl(stateWith({ enabled: false }))).toEqual({
      label: "Enable helper",
      action: "enable",
      note: ENABLE_NOTE,
    });
    expect(consentControl(stateWith({ enabled: true }))).toEqual({
      label: "Disable helper",
      action: "disable",
      note: DISABLE_NOTE,
    });
  });
});

describe("the page sweep", () => {
  test("covers the package the way it is really laid out", async () => {
    // Every guard above is a claim about the files this walk returns, so the walk
    // gets checked too. Round 25 is the reason it has to mirror the REAL layout:
    // the synthetic tree planted its `index.html` inside the swept directory, which
    // is not where the shipped shell lives, so a sweep rooted one level below the
    // package passed a self-test certifying a shape the repository never had.
    const root = mkdtempSync(path.join(tmpdir(), "subshell-panel-sweep-"));
    try {
      for (const name of [
        "index.html",
        "inline.ts",
        "package.json",
        "vite.config.ts",
        "src/main.ts",
        "src/state.ts",
        "src/strings.ts",
        "src/vite-env.d.ts",
        "src/styles.css",
        "src/copy.json",
        "src/icon.svg",
        "src/notes.txt",
        "src/consent/row.ts",
        "src/consent/row.css",
        "src/dist/inner.json",
        "src/guide.md",
        "src/__tests__/strings.test.ts",
        "dist/index.html",
        "node_modules/dep/index.ts",
      ]) {
        const file = path.join(root, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "export const x = 1;\n");
      }
      const swept = (await pageCode(pathToFileURL(`${root}/`))).map((source) => source.file);
      // The shell and the fold beside package.json count as page code, the copy
      // module is the only exemption, build output and dependencies are skipped at the
      // root only, and a directory is not a reason to miss a file: `src/dist/` is
      // someone's shipped data, not this package's build output.
      expect(swept.sort()).toEqual([
        "index.html",
        "inline.ts",
        "package.json",
        "src/consent/row.css",
        "src/consent/row.ts",
        "src/copy.json",
        "src/dist/inner.json",
        "src/guide.md",
        "src/icon.svg",
        "src/main.ts",
        "src/notes.txt",
        "src/state.ts",
        "src/styles.css",
        "vite.config.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the shell's title is the copy's title", async () => {
    // `index.html` carries the document title the webview shows, and it sat outside
    // the sweep long enough to duplicate `strings.title` by hand with nothing
    // comparing the two. Renaming the copy left a window titled one thing and a
    // panel heading saying another, both green.
    const shell = (await pageCode()).find((source) => source.file === "index.html");
    expect(shell, "the package still ships a root index.html").toBeTruthy();
    expect(/<title>([^<]*)<\/title>/.exec(shell?.code ?? "")?.[1]).toBe(strings.title);
  });

  test("every shipped file in the package is swept, whatever shape it is", async () => {
    // The list in the test above is hand-written, and round 26 found what that costs:
    // a `src/copy.json` holding the disabling sentence was invisible to the walk AND
    // invisible to the list, because the list came from the same filtered walk it was
    // meant to check. Round 27 found the same flaw inside that fix: enumerating `src/`
    // alone never asked about a package-root `data.json`, and reusing the sweep's own
    // skip set let `src/dist/copy.json` hide behind a directory name that is only
    // special at the top. So this walks the whole package with no extension filter,
    // skips nothing below the root, and exempts a named set instead of a derived one.
    const swept = new Set((await pageCode()).map((source) => source.file));
    const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
    const unswept = listShipped(packageRoot)
      .filter((file) => !file.endsWith(".d.ts")) // a declaration is not rendered
      .filter((file) => file !== COPY_FILE && !file.startsWith(TEST_DIR))
      .filter((file) => !swept.has(file))
      .sort();
    expect(unswept, "a shipped file the copy sweep never reads").toEqual([]);
    // The two root files round 25 lost, checked by name because their absence from a
    // `src/` listing would never have been noticed.
    for (const shell of ["index.html", "inline.ts"]) expect(swept.has(shell), `${shell} must be swept`).toBe(true);
  });
});

describe("the copy ban's decoding", () => {
  test("reads back the escapes a browser or a bundler will undo", () => {
    // Round 27 built the panel and found the words in the shipped page from a source
    // file the ban had called clean: vite decodes CSS escapes while minifying, so
    // `content: "En\61 ble helper"` renders "Enable helper" while its raw text
    // contains no banned word at all. Break a branch of `decodeEscapes` and this is
    // the test that says the ban went blind, rather than the plant that gets past it.
    expect(squash('content: "En\\61 ble helper";')).toContain(squash("Enable helper"));
    expect(squash('"En\\u0061ble helper"')).toContain(squash("Enable helper"));
    expect(squash("\\x45nable helper")).toContain(squash("Enable helper"));
    expect(squash("&#69;nable helper")).toContain(squash("Enable helper"));
    expect(squash("&#x45;nable helper")).toContain(squash("Enable helper"));
    // Ordinary text is unaffected in the ways that matter: letters and digits only.
    expect(squash("Disabling stops capture and input.")).toBe("Disablingstopscaptureandinput");
  });
});

describe("the panel's own copy stays in one file", () => {
  test("nothing outside strings.ts holds a consent sentence", async () => {
    // Kept separate from the door test so a failure says "someone typed the words"
    // rather than "someone reached through the object".
    const offenders: string[] = [];
    for (const { file, code } of await pageCode()) {
      // Plugs the one exemption this check's own reach depends on: a helper under a
      // test directory is not swept, so page code must not be importing from one.
      if (file !== "bunfig.toml" && IMPORTS_TEST_DIR.test(code))
        offenders.push(`${file} imports shipped copy from a test directory`);
      const flat = squash(code);
      for (const copy of COPY_THE_PAGE_MAY_NOT_HOLD) {
        if (flat.includes(squash(copy))) offenders.push(`${file} holds "${copy.slice(0, 32)}..." as its own copy`);
      }
    }
    expect(offenders).toEqual([]);
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
        expect(body).toContain("disconnects viewers and stops capture and input");
        expect(body).toContain("helper settings and macOS permissions don't change");
        expect(body).toContain("Your subshells keep running");
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
    expect(quitBody("notRegistered", true)).toContain("It won't start at sign-in.");
    expect(quitBody("needsApproval", true)).toContain("until you approve it in macOS");
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
