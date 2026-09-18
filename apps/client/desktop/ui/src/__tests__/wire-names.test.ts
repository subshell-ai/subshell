/**
 * Two strings cross the IPC boundary as WORDS, and nothing else holds either
 * of them to Rust.
 *
 * A `WebTarget` member the page names but Rust does not know is refused at
 * runtime — `invalid args … unknown variant`, in the window — which is not a
 * compile error and not something any type check sees. That is exactly what
 * shipped in `apps/server/desktop` on 2026-09-14: Rust derives its wire names
 * with `rename_all = "kebab-case"`, so `MacPorts` went across as `mac-ports`
 * while the page sent `macports`, and Open MacPorts site answered with a serde
 * error. This app copied that enum, so it copies the pin.
 *
 * `INSTALL_LINE_EVENT` is the same class with a quieter failure: an event name
 * spelled two ways is a listener that hears nothing, so the install pane would
 * simply never leave "Starting the package manager…" while the install ran
 * fine.
 *
 * `steps.test.ts` already covers `ProbeStep` with a plain kebab derivation;
 * what is here is the case that derivation cannot see — a variant carrying an
 * explicit `#[serde(rename = …)]`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTROL_RS = join(import.meta.dir, "../../../src-tauri/src/control.rs");
const IPC_TS = join(import.meta.dir, "../lib/ipc.ts");

interface RustEnum {
  /** The attribute lines immediately above `pub enum X {`. */
  attrs: string[];
  /** The variant lines between the braces. */
  body: string[];
}

/**
 * One enum's attributes and body, by name.
 *
 * The body is bounded at the closing brace in column zero, so a `match` over
 * the same variants further down the file cannot leak in and double every
 * name.
 */
function rustEnum(file: string, name: string): RustEnum {
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(`pub enum ${name} {`));
  expect(start, `pub enum ${name} in ${file}`).toBeGreaterThan(-1);
  const attrs: string[] = [];
  for (let i = start - 1; i >= 0 && (lines[i] as string).startsWith("#["); i--) attrs.unshift(lines[i] as string);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && lines[i] !== "}"; i++) body.push(lines[i] as string);
  return { attrs, body };
}

/**
 * What Rust actually puts on the wire: an explicit `rename`, else the
 * kebab-case of the variant name.
 *
 * The derivation is only honest while the enum really does carry
 * `rename_all = "kebab-case"`, so that is asserted rather than assumed — an
 * enum that lost the attribute would otherwise be compared against words serde
 * no longer writes, and this test would go green over the bug it exists for.
 */
function wireNames(file: string, name: string): string[] {
  const { attrs, body } = rustEnum(file, name);
  expect(attrs.join("\n"), `${name} must derive kebab-case wire names`).toContain('rename_all = "kebab-case"');
  const names: string[] = [];
  let renamed: string | null = null;
  for (const line of body) {
    const rename = line.match(/#\[serde\(rename\s*=\s*"([^"]+)"\)\]/);
    if (rename) {
      renamed = rename[1] as string;
      continue;
    }
    const variant = line.match(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/);
    if (!variant) continue;
    const kebab = (variant[1] as string).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    names.push(renamed ?? kebab);
    renamed = null;
  }
  expect(names.length, `${name} variants`).toBeGreaterThan(0);
  return names;
}

/** The members a TypeScript union names, in the order it names them. */
function unionMembers(file: string, name: string): string[] {
  const source = readFileSync(file, "utf8");
  const match = source.match(new RegExp(`export type ${name} =([^;]+);`));
  expect(match, `export type ${name} in ${file}`).not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

describe("WebTarget", () => {
  it("names exactly what Rust will accept, in the same spelling", () => {
    expect(unionMembers(IPC_TS, "WebTarget").sort()).toEqual(wireNames(CONTROL_RS, "WebTarget").sort());
  });

  it("covers both package managers the tmux screen offers", () => {
    // `MacPorts` kebabs to `mac-ports`, which is neither how the project
    // spells itself nor what the screen sends — Rust renames that one variant
    // and this is the assertion that notices if it stops.
    expect(unionMembers(IPC_TS, "WebTarget")).toContain("homebrew");
    expect(unionMembers(IPC_TS, "WebTarget")).toContain("macports");
  });
});

describe("the install-line event", () => {
  it("is spelled the same by the command that emits it and the page that listens", () => {
    const rust = readFileSync(CONTROL_RS, "utf8").match(/INSTALL_LINE_EVENT: &str = "([^"]+)"/);
    expect(rust, "INSTALL_LINE_EVENT in control.rs").not.toBeNull();
    const page = readFileSync(IPC_TS, "utf8").match(/INSTALL_LINE_EVENT = "([^"]+)"/);
    expect(page, "INSTALL_LINE_EVENT in lib/ipc.ts").not.toBeNull();
    expect(page?.[1]).toBe(rust?.[1] as string);
  });

  it("is emitted to the node window alone, never broadcast", () => {
    // The other window is a control plane's own page — remote content this app
    // tells nothing. `emit` would deliver a package manager's output there
    // too, and the reviewer of a future `emit` would have no test to fail.
    const rust = readFileSync(CONTROL_RS, "utf8");
    const emit = rust.match(/emit_to\(\s*crate::windows::NODE_LABEL,\s*INSTALL_LINE_EVENT/);
    expect(emit, "emit_to(NODE_LABEL, INSTALL_LINE_EVENT) in control.rs").not.toBeNull();
  });
});
