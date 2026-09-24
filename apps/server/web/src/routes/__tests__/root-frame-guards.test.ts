import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every child of the root frame that needs a SESSION must say so where it is
 * mounted.
 *
 * `shellGate` decides what the frame paints and is tested on its own, but it
 * deliberately returns "render" on `/login` and `/setup` (those pages must
 * paint) and on the two fail-open branches — offline, and a setup-status query
 * that did not answer. So "the gate let us render" is NOT "somebody is signed
 * in", and a child that assumes otherwise is mounted on a first-run wizard.
 *
 * `DesktopBridge` was exactly that: `{desktop && <DesktopBridge />}`, with no
 * session check at all, while every sibling carried one. It listens for the
 * native chrome's actions, and `new-subshell` opens a DIALOG rather than
 * navigating — so no route gate had anything to say about it, and the tray
 * could open the quick-add launch dialog over the setup wizard of an instance
 * with no users yet.
 *
 * Asserted at the source because this is JSX in `Shell`, not a value any pure
 * function returns. The check is deliberately loose about WHICH guard: some of
 * these use `!!user`, and the rail uses `!bare` alone on purpose, because a
 * server outage is not a sign-out (regression #8) and the frame is meant to
 * survive it. What is not acceptable, and what this catches, is a child with
 * no session-related condition whatsoever.
 */
const ROOT = join(import.meta.dir, "../__root.tsx");

/** Frame children that must not mount for an anonymous visitor. */
const SESSION_ONLY = [
  "DesktopBridge",
  "DesktopNotifications",
  "EmergencyLoginBanner",
  "LiveSubshellsFeedProvider",
  "MobileTopBar",
  "DesktopSidebar",
];

describe("the root frame's session-only children", () => {
  const source = readFileSync(ROOT, "utf8");

  for (const name of SESSION_ONLY) {
    test(`${name} is mounted behind a session check`, () => {
      // The JSX line that mounts it, not the import.
      const line = source.split("\n").find((l) => l.includes(`<${name}`) && !l.trimStart().startsWith("import"));
      expect(line, `no JSX mounting ${name}`).toBeDefined();
      const guarded = /\buser\b/.test(line ?? "") || /\bbare\b/.test(line ?? "");
      expect(guarded, `${name} mounts with no session check: ${line?.trim()}`).toBe(true);
    });
  }
});

/**
 * The frame's bottom safe-area padding must stay gated on the shell knowing
 * a page does NOT own its own bottom edge. The padding exists for the
 * scrolling pages; stacked under the key bar's own identical padding it
 * renders a background band below the bar — half of the PWA short-height
 * report (the other half is the standalone `dvh` bug, see
 * `use-visual-viewport-insets`). Asserted at the source because, like the
 * session guards above, this is JSX in `Shell`, not a value any pure
 * function returns; the predicate itself is unit-tested in
 * `lib/__tests__/app-frame.test.ts`.
 */
describe("the root frame's bottom padding", () => {
  const source = readFileSync(ROOT, "utf8");

  test("the outlet wrapper's safe-area padding is gated on the bottom-owner check", () => {
    const lines = source.split("\n").filter((l) => l.includes("pb-[env(safe-area-inset-bottom)]"));
    expect(lines.length, "no bottom safe-area padding line in __root.tsx").toBeGreaterThan(0);
    // EVERY occurrence, not the first — an ungated second one elsewhere
    // in the frame is exactly the regression this catches.
    for (const line of lines) {
      expect(line, `bottom padding ungated: ${line.trim()}`).toContain("bottomOwner");
    }
  });
});
