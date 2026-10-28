import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two assistants each ship a Virtual Displays screen, and the server one
 * says out loud that the client's steps and notes are "word-for-word this
 * screen's" apart from which app is named. A promise held by a comment is a
 * promise already drifting: the docs and the panel were rewritten twice on this
 * branch while both copies of the steps sat where they were, and the sign-in
 * sentence had already split from the code in both. This is the test that
 * comment should have been, in the shape `tokens-match-spa.test.ts` uses.
 *
 * Compared as text, not rendered: the two files import from their own app's
 * aliases, so neither can be mounted inside the other's build.
 */
const HERE = import.meta.dir;
const SERVER = join(HERE, "..", "display-screen.tsx");
// Six levels up from this test dir is `apps/` (→ screens → src → ui → desktop →
// server → apps), then down into the other assistant.
const CLIENT = join(HERE, "../../../../../../client/desktop/ui/src/components/assistant/display-screen.tsx");

/** The quoted strings in `const STEPS: readonly string[] = [ … ];`, app name folded. */
function stepsOf(source: string): string[] {
  const block = /const STEPS: readonly string\[\] = \[([\s\S]*?)\n\];/.exec(source)?.[1];
  if (block === undefined) throw new Error("no STEPS array found");
  return [...block.matchAll(/"((?:[^"\\]|\\.)+)"/g)]
    .map(([, line]) => line.replace(/Subshell (?:Client|Server)/g, "Subshell App").replace(/\\"/g, '"'))
    .filter((line) => line.length > 0);
}

describe("the two assistants' Virtual Displays screens", () => {
  const server = readFileSync(SERVER, "utf8");
  const client = readFileSync(CLIENT, "utf8");
  // A path that stops existing would otherwise pass by comparing nothing.
  expect(server.length).toBeGreaterThan(1000);
  expect(client.length).toBeGreaterThan(1000);

  test("ask for the same three things in the same order", () => {
    expect(stepsOf(client)).toEqual(stepsOf(server));
    // A vacuous comparison would be worse than none: three steps is the contract.
    expect(stepsOf(server).length).toBe(3);
  });

  test("each names its own app, and only where the app belongs", () => {
    expect(server).toContain("Subshell Server");
    expect(client).toContain("Subshell Client");
    expect(stepsOf(server).join(" ")).toContain("Subshell App");
  });

  test("both name the helper's own menu bar icon, not the app's", () => {
    // The note used to say "the same panel sits under Subshell Server (Client)
    // in the macOS menu bar". Two wrongs in one sentence: the panel is opened
    // from the helper's own status item, and a page inside Subshell Server
    // telling you to look under Subshell Server reads as a different program.
    // The sentence is app-independent, so it is compared whole.
    const note = /The helper runs as[\s\S]*?BetterDisplay needs\./;
    const serverNote = note.exec(server)?.[0];
    const clientNote = note.exec(client)?.[0];
    expect(serverNote, "the server screen carries the helper-menu note").toBeDefined();
    expect(clientNote?.replace(/\s+/g, " ")).toBe(serverNote?.replace(/\s+/g, " "));
    expect(serverNote).toContain("Subshell Display Helper");
    for (const source of [server, client]) {
      expect(source).not.toMatch(
        /sits under <span className="font-strong">Subshell (?:Client|Server)<\/span> in the macOS menu bar/,
      );
    }
  });

  test("both explain the same initial consent and warn about the same control", () => {
    for (const pattern of [
      /The helper starts disabled[\s\S]*?macOS permissions\./,
      /Requires macOS 14[\s\S]*?people you trust\./,
    ]) {
      const expected = pattern.exec(server)?.[0];
      expect(expected).toBeDefined();
      expect(pattern.exec(client)?.[0]?.replace(/\s+/g, " ")).toBe(expected?.replace(/\s+/g, " "));
    }
  });
  test("the host and client introduce a virtual display with the same sentence", () => {
    const host = readFileSync(join(HERE, "../../host.tsx"), "utf8");
    const subtitles = readFileSync(
      join(HERE, "../../../../../../client/desktop/ui/src/components/assistant/subtitles.ts"),
      "utf8",
    );
    const sentence = /A virtual display gives a subshell[^"\n]+/;
    expect(sentence.exec(host)?.[0]).toBeDefined();
    expect(sentence.exec(subtitles)?.[0]).toBe(sentence.exec(host)?.[0]);
  });

  test("neither promises a sign-in registration that enabling no longer does", () => {
    // The defect this pins is the one the split introduced: a step that told
    // people Enable helper also adds the login item, after the button stopped
    // doing it. The panel owns that choice now, on its own row.
    for (const step of stepsOf(server)) {
      expect(step).not.toMatch(/also starts the helper when you sign in/);
      expect(step).not.toMatch(/registers? .*login item/i);
    }
    expect(server).toContain("Launch at sign-in");
    expect(client).toContain("Launch at sign-in");
  });
});
