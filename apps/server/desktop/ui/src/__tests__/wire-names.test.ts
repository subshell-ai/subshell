/**
 * Three Rust enums cross the IPC boundary as WORDS, and nothing held any of
 * them to the TypeScript unions that spell them.
 *
 * A member the page names but Rust does not know is refused at runtime, with
 * `invalid args ... unknown variant`, in the window — not a compile error and
 * not something any type check sees. That is exactly what shipped on
 * 2026-09-14: Rust derives its wire names with `rename_all = "kebab-case"`,
 * so `MacPorts` went across as `mac-ports` while the page sent `macports`,
 * and Open MacPorts site answered with a serde error.
 *
 * The other two are the same failure with worse diagnostics:
 *
 * - **`SettingsPane`** is `WebTarget`'s exact shape — a closed enum the page
 *   names a member of — and it carries `FilesAndFolders`, the one variant in
 *   any of these three whose kebab spelling a person would not guess.
 * - **`Permission`** is worse than either, because it travels the other way.
 *   It is a value the page RECEIVES, so a drifted word is not a refusal with a
 *   message: it falls out of the exhaustive switches in
 *   `lib/permissions-model.ts` as `undefined`, and a row renders blank with no
 *   error anywhere. It is also spelled in THREE places — Rust, the assistant,
 *   and the SPA's own hand-written mirror — so it is the one with the most
 *   room to drift.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTROL_RS = join(import.meta.dir, "../../../src-tauri/src/control.rs");
const PERMISSIONS_RS = join(import.meta.dir, "../../../../../../crates/desktop-core/src/permissions.rs");
const IPC_TS = join(import.meta.dir, "../lib/ipc.ts");
const SPA_PERMISSIONS_TS = join(import.meta.dir, "../../../../web/src/types/permissions.ts");

interface RustEnum {
  /** The attribute lines immediately above `pub enum X {`. */
  attrs: string[];
  /** The variant lines between the braces. */
  body: string[];
}

/**
 * One enum's attributes and body, by name.
 *
 * The body is bounded at the closing brace in column zero so a `match` over
 * the same variants further down the file — `Permission::as_str`, say —
 * cannot leak in and double every name.
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

  it("still covers both package managers the tmux screen offers", () => {
    expect(unionMembers(IPC_TS, "WebTarget")).toContain("homebrew");
    expect(unionMembers(IPC_TS, "WebTarget")).toContain("macports");
  });
});

describe("SettingsPane", () => {
  it("names exactly what Rust will accept, in the same spelling", () => {
    expect(unionMembers(IPC_TS, "SettingsPane").sort()).toEqual(wireNames(CONTROL_RS, "SettingsPane").sort());
  });

  it("carries the pane the files row opens, spelled the way serde writes it", () => {
    // `FilesAndFolders` kebabs to `files-and-folders`, and the permissions
    // screen's files row sends it on every render — the variant was defined
    // and granted and sent by nothing at all until the dead-end was fixed.
    expect(unionMembers(IPC_TS, "SettingsPane")).toContain("files-and-folders");
  });
});

describe("Permission", () => {
  const rust = (): string[] => wireNames(PERMISSIONS_RS, "Permission");

  it("is spelled the same by Rust and by the assistant", () => {
    expect(unionMembers(IPC_TS, "Permission").sort()).toEqual(rust().sort());
  });

  it("is spelled the same by the SPA, which mirrors it by hand", () => {
    // The dashboard reads these words from `desktop_permissions` rather than
    // from the probe, and it has its own copy of the union. Three spellings,
    // one wire format.
    expect(unionMembers(SPA_PERMISSIONS_TS, "Permission").sort()).toEqual(rust().sort());
  });

  it("has a runtime list in the SPA that holds every word", () => {
    // `PERMISSIONS` is what anything iterating or validating the wire reads,
    // and a list that trailed the union would validate a real value as junk.
    const source = readFileSync(SPA_PERMISSIONS_TS, "utf8");
    const list = source.match(/export const PERMISSIONS[^=]*=([^;]+);/);
    expect(list).not.toBeNull();
    const words = [...(list?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    expect(words.sort()).toEqual(rust().sort());
  });

  it("gives `as_str` the same words serde writes", () => {
    // Rust spells these twice — once for serde, once for callers holding a
    // `Permission` without serializing one. A drift between the two is a log
    // line and a wire frame disagreeing about the same machine.
    const source = readFileSync(PERMISSIONS_RS, "utf8");
    const arms = [...source.matchAll(/Permission::([A-Za-z0-9]+)\s*=>\s*"([^"]+)"/g)];
    expect(arms.length).toBe(rust().length);
    for (const [, variant, word] of arms) {
      const kebab = (variant as string).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      expect(word, variant).toBe(kebab);
    }
  });
});
