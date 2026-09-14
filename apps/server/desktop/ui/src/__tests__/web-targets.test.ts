/**
 * The page's `WebTarget` union and Rust's `WebTarget` enum are ONE contract,
 * and nothing held them together.
 *
 * A member the page names but Rust does not know is refused at runtime, with
 * `invalid args ... unknown variant`, in the window — not a compile error and
 * not something any type check sees. That is exactly what shipped on
 * 2026-09-14: Rust derives its wire names with `rename_all = "kebab-case"`,
 * so `MacPorts` went across as `mac-ports` while the page sent `macports`,
 * and Open MacPorts site answered with a serde error.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTROL_RS = join(import.meta.dir, "../../../src-tauri/src/control.rs");
const IPC_TS = join(import.meta.dir, "../lib/ipc.ts");

/** The enum body, so a `WebTarget` mentioned elsewhere in the file cannot leak in. */
function webTargetBody(): string {
  const source = readFileSync(CONTROL_RS, "utf8");
  const start = source.indexOf("pub enum WebTarget {");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end);
}

/** What Rust actually puts on the wire: an explicit rename, else kebab-case. */
function rustWireNames(): string[] {
  const names: string[] = [];
  // Each variant is the last identifier before its comma, with an optional
  // `#[serde(rename = "…")]` immediately above it.
  for (const line of webTargetBody().split("\n")) {
    const renamed = line.match(/#\[serde\(rename\s*=\s*"([^"]+)"\)\]/);
    if (renamed) {
      names.push(renamed[1] as string);
      continue;
    }
    const variant = line.match(/^\s{4}([A-Z][A-Za-z]*),\s*$/);
    if (!variant) continue;
    const kebab = (variant[1] as string).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    // A renamed variant already pushed its wire name on the line above.
    if (!names.includes(kebab.replace(/-/g, ""))) names.push(kebab);
  }
  return names;
}

/** The union members the page believes it may send. */
function pageTargets(): string[] {
  const source = readFileSync(IPC_TS, "utf8");
  const match = source.match(/export type WebTarget =([^;]+);/);
  expect(match).not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

describe("WebTarget", () => {
  it("names exactly what Rust will accept, in the same spelling", () => {
    expect(pageTargets().sort()).toEqual(rustWireNames().sort());
  });

  it("still covers both package managers the tmux screen offers", () => {
    expect(pageTargets()).toContain("homebrew");
    expect(pageTargets()).toContain("macports");
  });
});
