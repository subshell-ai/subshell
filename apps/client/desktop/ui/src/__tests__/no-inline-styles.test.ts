/**
 * The CSP guard, and why it is a test rather than a convention.
 *
 * The bundle's policy is `default-src 'self'; script-src 'self'; style-src
 * 'self'` with NO `'unsafe-inline'`. A `style-src` without `'unsafe-inline'`
 * blocks inline style ATTRIBUTES as well as `<style>` elements — so a React
 * `style={{…}}` prop is not an error, a warning, or a visible break: it is a
 * silently unstyled element in a production bundle that looked fine in dev,
 * where `devCsp` relaxes the same policy so Vite can inject its HMR styles.
 * `dangerouslySetInnerHTML` fails the same way, inertly.
 *
 * An invisible failure mode needs a guard, not a rule someone remembers.
 * Tailwind classes are the only styling mechanism here.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const UI_ROOT = join(import.meta.dir, "../..");
const UI_SRC = join(import.meta.dir, "..");

/**
 * This file, which necessarily contains the very patterns it looks for.
 * Nothing else is exempt — including other tests, which have no reason to
 * reach for an inline style either.
 */
const SELF = basename(import.meta.file);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

describe("nothing under ui/src can be styled inline", () => {
  const files = sourceFiles(UI_SRC).filter((f) => basename(f) !== SELF);

  it("finds files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("uses no `style` prop or attribute", () => {
    for (const file of files) {
      const body = readFileSync(file, "utf8");
      // `style={...}` (a JSX prop) and `style="..."` (an HTML attribute).
      expect(body, file).not.toMatch(/\bstyle\s*=\s*[{"']/);
    }
  });

  it("uses no dangerouslySetInnerHTML", () => {
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toContain("dangerouslySetInnerHTML");
    }
  });
});

describe("the HTML shell", () => {
  const html = readFileSync(join(UI_ROOT, "index.html"), "utf8");

  // Vite's own injections are configured off in vite.config.ts (the
  // module-preload polyfill is an INLINE script), but the hand-written shell
  // must not add its own either.
  it("carries no inline script or style block", () => {
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
  });

  it("is dark from the first paint, matching the dark-only palette", () => {
    expect(html).toContain('class="dark"');
  });
});
