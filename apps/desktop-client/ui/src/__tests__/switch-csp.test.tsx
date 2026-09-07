/**
 * The one primitive that fights the CSP, and the stylesheet rule that answers
 * it.
 *
 * `Switch.Root` (Base UI 1.7.0) renders a hidden native checkbox and hides it
 * with an inline style attribute. `style-src 'self'` without `'unsafe-inline'`
 * drops inline style ATTRIBUTES, so in a shipped bundle that checkbox is
 * visible — and it is NOT visible under `tauri dev`, where `devCsp` relaxes the
 * same rule, so this is invisible in every place a developer would look.
 *
 * `styles.css` restates the hiding from a stylesheet. This test keeps the two
 * facts tied together: that Base UI still emits the input, and that the rule's
 * selector still describes it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { Switch } from "@/components/ui/switch";

const styles = readFileSync(join(import.meta.dir, "../styles.css"), "utf8");

/** The selector `styles.css` uses, kept in one place so the two cannot drift. */
const SELECTOR = 'input[type="checkbox"][aria-hidden="true"][tabindex="-1"]';

describe("the switch under a no-unsafe-inline CSP", () => {
  afterEach(cleanup);

  it("still renders a hidden input that carries an inline style", () => {
    const { container } = render(<Switch checked={false} />);
    const input = container.querySelector('input[type="checkbox"]');
    // If this ever goes null, Base UI stopped needing the workaround: delete
    // the `input[type="checkbox"][aria-hidden…]` block in styles.css and this
    // file together.
    expect(input).not.toBeNull();
    expect(input?.getAttribute("style")).toBeTruthy();
  });

  it("is matched by the stylesheet rule that hides it without that inline style", () => {
    const { container } = render(<Switch checked={false} />);
    expect(container.querySelector(SELECTOR)).not.toBeNull();
    expect(styles).toContain(SELECTOR);
  });

  it("hides it the same way `visuallyHiddenInput` does", () => {
    const rule = styles.slice(styles.indexOf(SELECTOR));
    const body = rule.slice(rule.indexOf("{"), rule.indexOf("}"));
    expect(body).toContain("position: absolute");
    expect(body).toContain("width: 1px");
    expect(body).toContain("height: 1px");
    expect(body).toContain("clip-path: inset(50%)");
  });

  it("still renders a real switch role for the rest of the page to drive", () => {
    const { container } = render(<Switch checked />);
    const root = container.querySelector('[data-slot="switch"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute("role")).toBe("switch");
    expect(root?.getAttribute("aria-checked")).toBe("true");
  });
});
