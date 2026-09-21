import { describe, expect, test } from "bun:test";
import {
  type ConfirmReadline,
  classifyPortConflict,
  confirmOn,
  definitionFirstCommand,
  devServerPort,
  isConfirm,
  type PortListener,
  parseAppPids,
  parseDevServerPort,
  parseLsofListeners,
  parseServiceStatus,
} from "../desktop-dev";

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

/**
 * The :3080 preflight (operator ruling 2026-09-21): the installed
 * `subshell-server` service holds the port the freshly built sidecar binds, so
 * the launcher offers to stop it before staging anything. The seams below are
 * the parts that must not depend on a live port, a live service, or lsof.
 */

describe("parseLsofListeners", () => {
  test("parses the record shape this lsof build emits, fd line included", () => {
    // Measured on macOS 25 (2026-09-21): `p` then `c` then an `f` line that was
    // NOT asked for. Unknown fields are ignored, so the parser survives lsof
    // variants that print more than it was asked for.
    const out = "p67215\ncsubshell-server\nf11\n";
    expect(parseLsofListeners(out)).toEqual([{ pid: 67215, command: "subshell-server" }]);
  });

  test("parses several records, each starting at its own p line", () => {
    const out = "p101\nca\nf3\np202\ncb\nf5\n";
    expect(parseLsofListeners(out)).toEqual([
      { pid: 101, command: "a" },
      { pid: 202, command: "b" },
    ]);
  });

  test("empty output — lsof found no listener — parses to an empty list", () => {
    // lsof exits 1 with no output when the port is free; the launcher reads
    // stdout either way.
    expect(parseLsofListeners("")).toEqual([]);
  });

  test("a record with no c line keeps its pid with an empty command", () => {
    const out = "p4242\n";
    expect(parseLsofListeners(out)).toEqual([{ pid: 4242, command: "" }]);
  });

  test("malformed pid lines are dropped, not guessed", () => {
    const out = "pnot-a-pid\ncx\np8888\ncreal\n";
    expect(parseLsofListeners(out)).toEqual([{ pid: 8888, command: "real" }]);
  });

  test("one pid bound on both stacks is one entry, not two", () => {
    // lsof emits one record per SOCKET, so a listener bound v4+v6 renders the
    // same process twice; the verdict and the on-screen holder list are about
    // PROCESSES. The first c line wins and the duplicate's own command is
    // ignored.
    const out = "p67215\ncsubshell-server\nf11\np67215\ncsubshell-server\nf12\n";
    expect(parseLsofListeners(out)).toEqual([{ pid: 67215, command: "subshell-server" }]);
  });
});

describe("parseDevServerPort", () => {
  test("unset or empty reads the compiled default, 3080", () => {
    expect(parseDevServerPort(undefined)).toEqual({ ok: true, port: 3080 });
    expect(parseDevServerPort("")).toEqual({ ok: true, port: 3080 });
  });

  test("a valid value is honoured, whatever the default is", () => {
    expect(parseDevServerPort("3099")).toEqual({ ok: true, port: 3099 });
    expect(parseDevServerPort("1")).toEqual({ ok: true, port: 1 });
  });

  test("an invalid value is reported, never fallen back from", () => {
    // The server's own asPortNumber() THROWS on these — dev must refuse the
    // same values, or the default-YES prompt stops the operator's real
    // service for a launch that cannot boot.
    for (const bad of ["not-a-port", "0", "65536", "-1", "30.5", "NaN"]) {
      expect(parseDevServerPort(bad)).toEqual({ ok: false, value: bad });
    }
  });
});

describe("devServerPort (env save/restore)", () => {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: the value under test, saved to whatever this shell had
  const ORIGINAL = process.env.SERVER_PORT;

  function restore(): void {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: the value under test, restored to whatever this shell had
    if (ORIGINAL === undefined) delete process.env.SERVER_PORT;
    else process.env.SERVER_PORT = ORIGINAL;
  }

  test("reads the shell's SERVER_PORT, the same value the sidecar inherits", () => {
    try {
      process.env.SERVER_PORT = "3099";
      expect(devServerPort()).toBe(3099);
    } finally {
      restore();
    }
  });

  test("absent reads the default", () => {
    try {
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: the value under test
      delete process.env.SERVER_PORT;
      expect(devServerPort()).toBe(3080);
    } finally {
      restore();
    }
  });
});

describe("confirmOn", () => {
  /** A readline stand-in whose question never resolves until `close()` fires. */
  function fakeRl(): { rl: ConfirmReadline; close: () => void; resolve: (answer: string) => void } {
    let resolveQuestion: ((answer: string) => void) | undefined;
    let closeListener: (() => void) | undefined;
    const rl: ConfirmReadline = {
      question: () =>
        new Promise<string>((resolve) => {
          resolveQuestion = resolve;
        }),
      once: (_event, listener) => {
        closeListener = listener;
      },
    };
    return { rl, close: () => closeListener?.(), resolve: (answer) => resolveQuestion?.(answer) };
  }

  test("a typed answer decides, exactly as isConfirm says", async () => {
    const fake = fakeRl();
    const pending = confirmOn(fake.rl, "?");
    fake.resolve("y");
    expect(await pending).toBe(true);
  });

  test("the stream closing without an answer is a DECLINE, not the default YES", async () => {
    // Measured by the reviewer on c1a20b8c: under Bun, an input that ends
    // before an answer never resolves `rl.question` — and mapping close to ""
    // would read it as YES and stop the operator's running service. The
    // prompt's default is for a typed Enter, never for an input that closed.
    const fake = fakeRl();
    const pending = confirmOn(fake.rl, "?");
    fake.close();
    expect(await pending).toBe(false);
  });

  test("close with a question already pending 'n' still declines", async () => {
    const fake = fakeRl();
    const pending = confirmOn(fake.rl, "?");
    fake.resolve("n");
    expect(await pending).toBe(false);
  });
});

describe("classifyPortConflict", () => {
  const held: PortListener[] = [{ pid: 67215, command: "subshell-server" }];
  const ourService = { installed: true, state: "running", pid: 67215 };
  const stopped = { installed: true, state: "stopped", pid: null };

  test("a free port needs no verdict beyond free", () => {
    expect(classifyPortConflict([], ourService)).toBe("free");
    expect(classifyPortConflict([], null)).toBe("free");
  });

  test("the installed service running at the listener's pid is ours — the offer case", () => {
    // The live shape the ruling was written from: the service's main pid IS
    // the pid lsof named on :3080.
    expect(classifyPortConflict(held, ourService)).toBe("our-service");
  });

  test("the port held with no service answer is foreign — never killed", () => {
    expect(classifyPortConflict(held, null)).toBe("foreign");
  });

  test("an installed but stopped service does not make a foreign holder ours", () => {
    expect(classifyPortConflict(held, stopped)).toBe("foreign");
  });

  test("a RUNNING service whose pid is NOT the listener is still foreign", () => {
    // The service binds its configured port; the thing on THIS port is
    // something else, and stopping the service would not free it.
    expect(classifyPortConflict(held, { installed: true, state: "running", pid: 9999 })).toBe("foreign");
  });

  test("an uninstalled definition (state unknown) is foreign", () => {
    expect(classifyPortConflict(held, { installed: false, state: "not-installed", pid: null })).toBe("foreign");
  });
});

describe("parseServiceStatus", () => {
  test("reads the CLI's --json output", () => {
    expect(
      parseServiceStatus(JSON.stringify({ installed: true, state: "running", pid: 67215, enabled: true })),
    ).toEqual({
      installed: true,
      state: "running",
      pid: 67215,
    });
  });

  test("a missing pid reads as null, and the extra fields are dropped", () => {
    expect(parseServiceStatus(JSON.stringify({ installed: true, state: "stopped" }))).toEqual({
      installed: true,
      state: "stopped",
      pid: null,
    });
  });

  test("anything that is not the shape is null — an unreadable answer is never a verdict", () => {
    expect(parseServiceStatus("subshell-server: not a json line")).toBeNull();
    expect(parseServiceStatus('{"state": "running"}')).toBeNull();
  });
});

describe("isConfirm", () => {
  test("the default is YES: empty, y, yes, in any case, whitespace included", () => {
    for (const answer of ["", "y", "Y", "yes", "YES", " Yes ", "  y  "]) {
      expect(isConfirm(answer)).toBe(true);
    }
  });

  test("anything else declines — including a stray word the prompt did not offer", () => {
    for (const answer of ["n", "N", "no", "No", "stop", "y ever", "1"]) {
      expect(isConfirm(answer)).toBe(false);
    }
  });
});

describe("definitionFirstCommand", () => {
  test("reads launchd's first ProgramArguments string", () => {
    const plist = [
      "<dict>",
      "  <key>Label</key><string>dev.subshell.server</string>",
      "  <key>ProgramArguments</key>",
      "  <array>",
      "    <string>/Users/me/.local/bin/subshell-server</string>",
      "    <string>run</string>",
      "  </array>",
      "</dict>",
    ].join("\n");
    expect(definitionFirstCommand(plist, "darwin")).toBe("/Users/me/.local/bin/subshell-server");
  });

  test("reads systemd's ExecStart binary", () => {
    const unit = "[Service]\nExecStart=/usr/local/bin/subshell-server serve\nRestart=on-failure\n";
    expect(definitionFirstCommand(unit, "linux")).toBe("/usr/local/bin/subshell-server");
  });

  test("neither shape answers null", () => {
    expect(definitionFirstCommand("[Service]\nRestart=on-failure\n", "linux")).toBeNull();
    expect(definitionFirstCommand("<dict/>", "darwin")).toBeNull();
  });
});
