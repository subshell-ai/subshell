import { describe, expect, test } from "bun:test";
import { type OwnedCommands, parseAppPids } from "../desktop-dev";

/**
 * The dev launcher kills app processes that outlived `tauri dev` — a desktop
 * reset restarts the app, and the replacement survives the Vite dev server
 * that renders it. Picking the right PIDs out of `ps` is the whole risk in
 * that: too loose and it kills another session's window, too tight and the
 * blank-window process it exists for slips through.
 */
const SERVER: OwnedCommands = {
  binary: "target/debug/subshell-desktop",
  vite: "apps/server/desktop/node_modules/.bin/vite",
};
const CLIENT: OwnedCommands = {
  binary: "target/debug/subshell-desktop-client",
  vite: "apps/client/desktop/node_modules/.bin/vite",
};

describe("parseAppPids", () => {
  test("matches both spellings the same process can have", () => {
    // `cargo run` starts it from src-tauri/, so ps shows a RELATIVE path; a
    // replacement the app spawned for itself shows the absolute one. Both are
    // the process this sweep exists to find.
    const ps = [
      "  501 target/debug/subshell-desktop",
      "  502 /Users/theo/projects/subshell/apps/server/desktop/src-tauri/target/debug/subshell-desktop",
    ].join("\n");
    expect(parseAppPids(ps, SERVER, new Set())).toEqual([501, 502]);
  });

  test("the client crate is not the server crate, though one prefixes the other", () => {
    // `subshell-desktop` is a literal prefix of `subshell-desktop-client`, so
    // a `includes` would make `dev:desktop-server` kill the client's window.
    // The match is anchored at the end for exactly this.
    const ps = ["  601 target/debug/subshell-desktop-client"].join("\n");
    expect(parseAppPids(ps, SERVER, new Set())).toEqual([]);
    expect(parseAppPids(ps, CLIENT, new Set())).toEqual([601]);
  });

  test("ignores the PIDs that were already running when this session started", () => {
    // Another developer session, or a window someone left open deliberately.
    // This script kills what its own run leaked and nothing else.
    const ps = ["  701 target/debug/subshell-desktop", "  702 target/debug/subshell-desktop"].join("\n");
    expect(parseAppPids(ps, SERVER, new Set([701]))).toEqual([702]);
  });

  test("does not match a command that merely mentions the path", () => {
    // The launcher, an editor, a grep — all carry the path in their argv and
    // none of them is the app.
    const ps = [
      "  801 bun scripts/desktop-dev.ts server",
      "  802 tail -f target/debug/subshell-desktop.log",
      "  803 /bin/zsh -c ls target/debug/subshell-desktop && echo",
    ].join("\n");
    expect(parseAppPids(ps, SERVER, new Set())).toEqual([]);
  });

  test("survives the shapes ps actually emits", () => {
    // Leading-space alignment for narrow PIDs, a trailing blank line, and a
    // header-less dump (`pid=,command=` prints no header, but an empty line
    // costs nothing to tolerate).
    const ps = "    9 target/debug/subshell-desktop\n\n 12345 target/debug/subshell-desktop\n";
    expect(parseAppPids(ps, SERVER, new Set())).toEqual([9, 12345]);
  });

  test("a process whose name merely ends the same way is not a match", () => {
    // A different checkout is out of scope by the ignore-set rule, but a
    // different BINARY must never match: the suffix carries target/debug/.
    const ps = ["  901 /opt/tools/bin/subshell-desktop"].join("\n");
    expect(parseAppPids(ps, SERVER, new Set())).toEqual([]);
  });

  test("kills the app's OWN vite, and never the SPA one a developer started", () => {
    // `tauri dev` runs the app's UI dev server as beforeDevCommand, and every
    // bundled window loads from it — a leaked app with no vite is exactly the
    // white window this sweep exists for, so both halves go. But
    // `apps/server/web` runs a vite of its own that somebody started on
    // purpose for SPA hot-reload; matching the bare word would kill it.
    const ps = [
      "  301 node /Users/theo/projects/subshell/apps/server/desktop/node_modules/.bin/vite",
      "  302 node /Users/theo/projects/subshell/apps/server/web/node_modules/.bin/vite",
    ].join("\n");
    expect(parseAppPids(ps, SERVER, new Set())).toEqual([301]);
  });

  test("one app's vite is not the other's", () => {
    const ps = ["  401 node /repo/apps/client/desktop/node_modules/.bin/vite"].join("\n");
    expect(parseAppPids(ps, SERVER, new Set())).toEqual([]);
    expect(parseAppPids(ps, CLIENT, new Set())).toEqual([401]);
  });
});
