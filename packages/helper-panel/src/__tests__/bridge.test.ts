import { describe, expect, test } from "bun:test";
import { EMPTY_STATE, type LoginItemState } from "../state";

/**
 * The two names that cross between the helper process and this page: the state
 * keys Swift pushes in, and the login-item words it pushes as values. Nothing
 * type-checks either edge (one side is Swift), and both fail the same quiet way.
 * `main.ts` merges whatever arrives over `EMPTY_STATE`, so a key Swift renames is
 * not an error, it is a panel that keeps reading "Disabled. Nothing is captured
 * and no input is accepted." on a Mac that is consented and capturing. The
 * consent surface, lying about the machine, is the failure this guards.
 */
const settingsPath = new URL("../../../../native/display-helper/Settings.swift", import.meta.url);
const themePath = new URL("../../../../native/display-helper/Theme.swift", import.meta.url);

describe("the helper's state push", () => {
  test("Swift's snapshot names exactly the fields the page renders", async () => {
    const swift = await Bun.file(settingsPath).text();
    const body = /func snapshot\(\) -> \[String: Any\] \{([\s\S]*?)\n {8}\]/.exec(swift)?.[1];
    // A miss here means Swift reshaped the function and this test stopped
    // looking. Empty is never a pass.
    expect(body, "Settings.swift still builds snapshot() as a dictionary literal").toBeTruthy();
    const keys = [...(body as string).matchAll(/"([A-Za-z]+)"\s*:/g)].map((match) => match[1] as string);
    expect(keys.sort()).toEqual(Object.keys(EMPTY_STATE).sort());
  }, 10_000);

  test("every login-item word the page can render is one Swift can return", async () => {
    // `loginItemLine` has a sentence per state, and the panel's `notRegistered`
    // reading is what a renamed word would silently fall back to: a helper
    // registered with macOS told it was not, with no way to see the difference.
    const [settings, theme] = await Promise.all([Bun.file(settingsPath).text(), Bun.file(themePath).text()]);
    expect(settings, "snapshot() feeds loginItem from LoginItem.pageState").toContain("LoginItem.pageState(");
    const words = [...(theme as string).matchAll(/return "(registered|needsApproval|notRegistered)"/g)].map(
      (match) => match[1] as LoginItemState,
    );
    expect([...new Set(words)].sort()).toEqual(["needsApproval", "notRegistered", "registered"]);
  }, 10_000);
});
