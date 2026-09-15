import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  binaryIsReplaceable,
  type InstalledBinaryDeps,
  parseSystemdExec,
  resolveInstalledBinary,
} from "@/services/installed-binary.js";
import { DESKTOP_SUPERVISOR } from "@/services/server-deployment.js";

/**
 * The two readers here are ports of the desktop app's Rust
 * (`server_bin.rs:76-160`), and the reason they are worth pinning is that both
 * of their failures are silent: a quoted `ExecStart` mis-split names a path
 * that does not exist, and a dev-form install read as one token hands the
 * updater a copy of `bun` to overwrite.
 */

let home = "";
let configDir = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "instbin-"));
  configDir = join(home, ".config", "subshell-server");
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Write a systemd user unit with the given ExecStart lines. */
function writeUnit(...execStarts: string[]): void {
  const dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "subshell-server.service"),
    `[Unit]\nDescription=Subshell\n\n[Service]\n${execStarts.map((e) => `ExecStart=${e}`).join("\n")}\n`,
  );
}

/** Write a launchd plist with the given ProgramArguments. */
function writePlist(argv: string[], where: "login" | "session" = "login"): string {
  const dir = where === "login" ? join(home, "Library", "LaunchAgents") : configDir;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "dev.subshell.server.plist");
  writeFileSync(
    path,
    `<?xml version="1.0"?>\n<plist version="1.0"><dict>\n<key>ProgramArguments</key>\n<array>\n${argv
      .map((a) => `\t<string>${a}</string>`)
      .join("\n")}\n</array>\n</dict></plist>\n`,
  );
  return path;
}

/** Deps with nothing on any rung but the ones a case sets up. */
function deps(over: Partial<InstalledBinaryDeps> = {}): InstalledBinaryDeps {
  return {
    home,
    configDir,
    platform: "linux",
    execPath: "/usr/bin/bun",
    env: {},
    ppid: 1,
    // Refuse plutil by default; darwin cases that want it inject a runner.
    runCmd: () => ({ code: 1, out: "", err: "command not found" }),
    ...over,
  };
}

describe("parseSystemdExec", () => {
  it("splits a plain line on whitespace", () => {
    expect(parseSystemdExec("/home/me/.local/bin/subshell-server")).toEqual(["/home/me/.local/bin/subshell-server"]);
    expect(parseSystemdExec("/usr/bin/bun /repo/apps/server/api/src/index.ts")).toEqual([
      "/usr/bin/bun",
      "/repo/apps/server/api/src/index.ts",
    ]);
  });

  it("unpicks the double-quoting systemdQuote applies to a spaced path", () => {
    // The inverse of `service.ts`'s systemdQuote. A macOS "Application
    // Support" home or a spaced config dir is what produces one at all.
    expect(parseSystemdExec('"/Users/me/Application Support/subshell-server"')).toEqual([
      "/Users/me/Application Support/subshell-server",
    ]);
    expect(parseSystemdExec('"/a b/bun" "/c d/index.ts"')).toEqual(["/a b/bun", "/c d/index.ts"]);
  });

  it("honours the two in-quote escapes systemd does", () => {
    expect(parseSystemdExec('"/a\\"b/subshell-server"')).toEqual(['/a"b/subshell-server']);
    expect(parseSystemdExec('"/a\\\\b/subshell-server"')).toEqual(["/a\\b/subshell-server"]);
  });

  it("answers an empty argv for an empty line", () => {
    expect(parseSystemdExec("")).toEqual([]);
    expect(parseSystemdExec("   ")).toEqual([]);
  });
});

describe("resolveInstalledBinary — the service definition", () => {
  it("reads a compiled systemd install, taking the LAST ExecStart", () => {
    // systemd's own rule is last-wins, and a drop-in that resets and re-sets
    // the line is the shape that produces two.
    writeUnit("/old/subshell-server", `${home}/.local/bin/subshell-server`);
    expect(resolveInstalledBinary(deps())).toEqual({
      kind: "compiled",
      path: `${home}/.local/bin/subshell-server`,
      source: "service definition",
    });
  });

  it("reads a spaced path out of a quoted ExecStart", () => {
    writeUnit('"/Users/me/My Apps/subshell-server"');
    const found = resolveInstalledBinary(deps());
    expect(found).toEqual({
      kind: "compiled",
      path: "/Users/me/My Apps/subshell-server",
      source: "service definition",
    });
  });

  it("calls a dev-form install SOURCE, carrying both tokens", () => {
    // The trap `server_bin.rs` names: a reader that kept only the first token
    // would hand `update` a copy of `bun` to overwrite.
    writeUnit("/usr/local/bin/bun /repo/apps/server/api/src/index.ts");
    const found = resolveInstalledBinary(deps());
    expect(found.kind).toBe("source");
    expect(found.kind === "source" && found.argv).toEqual(["/usr/local/bin/bun", "/repo/apps/server/api/src/index.ts"]);
    expect(found.kind === "source" && found.reason).toMatch(/checkout/);
  });

  it("reads the launchd plist through plutil", () => {
    const path = writePlist([`${home}/.local/bin/subshell-server`]);
    const found = resolveInstalledBinary(
      deps({
        platform: "darwin",
        runCmd: (cmd) => {
          expect(cmd[0]).toBe("/usr/bin/plutil");
          expect(cmd.at(-1)).toBe(path);
          return { code: 0, out: JSON.stringify([`${home}/.local/bin/subshell-server`]), err: "" };
        },
      }),
    );
    expect(found).toEqual({
      kind: "compiled",
      path: `${home}/.local/bin/subshell-server`,
      source: "service definition",
    });
  });

  it("finds the SESSION plist too, which is where --no-autostart puts it", () => {
    // Checking only ~/Library/LaunchAgents makes this rung vanish for a
    // machine installed without autostart, silently falling through to a
    // binary the service does not run.
    writePlist([`${home}/.local/bin/subshell-server`], "session");
    const found = resolveInstalledBinary(
      deps({
        platform: "darwin",
        runCmd: () => ({ code: 0, out: JSON.stringify([`${home}/.local/bin/subshell-server`]), err: "" }),
      }),
    );
    expect(found.kind === "compiled" && found.path).toBe(`${home}/.local/bin/subshell-server`);
  });

  it("falls back to the XML when plutil is not there", () => {
    writePlist([`${home}/.local/bin/subshell-server`]);
    const found = resolveInstalledBinary(deps({ platform: "darwin" }));
    expect(found.kind === "compiled" && found.path).toBe(`${home}/.local/bin/subshell-server`);
  });

  it("calls a two-token launchd install SOURCE as well", () => {
    writePlist(["/opt/homebrew/bin/bun", "/repo/apps/server/api/src/index.ts"]);
    expect(resolveInstalledBinary(deps({ platform: "darwin" })).kind).toBe("source");
  });
});

describe("resolveInstalledBinary — the other rungs", () => {
  it("answers the app supervisor's own execPath when the claim checks out", () => {
    const found = resolveInstalledBinary(
      deps({
        execPath: "/Applications/Subshell Server.app/Contents/MacOS/subshell-server-bundled",
        env: { SUBSHELL_SUPERVISOR: DESKTOP_SUPERVISOR, SUBSHELL_SUPERVISOR_PID: "4242" },
        ppid: 4242,
      }),
    );
    expect(found).toEqual({
      kind: "compiled",
      path: "/Applications/Subshell Server.app/Contents/MacOS/subshell-server-bundled",
      source: "app supervisor",
    });
  });

  it("ignores a supervisor claim whose pid is not our parent", () => {
    // The claim alone is worthless; the parentage is what makes it evidence.
    const found = resolveInstalledBinary(
      deps({
        execPath: "/usr/bin/bun",
        env: { SUBSHELL_SUPERVISOR: DESKTOP_SUPERVISOR, SUBSHELL_SUPERVISOR_PID: "999" },
        ppid: 4242,
      }),
    );
    expect(found.kind).toBe("unknown");
  });

  it("recognises a hand-run installed binary", () => {
    expect(resolveInstalledBinary(deps({ execPath: `${home}/.local/bin/subshell-server` }))).toEqual({
      kind: "compiled",
      path: `${home}/.local/bin/subshell-server`,
      source: "this process",
    });
  });

  it("does not mistake a compiled binary's own bunfs entry for an installed file", () => {
    expect(resolveInstalledBinary(deps({ execPath: "/$bunfs/root/subshell-server" })).kind).toBe("unknown");
  });

  it("answers unknown with a reason for `bun src/index.ts` from a checkout", () => {
    const found = resolveInstalledBinary(deps({ execPath: "/opt/homebrew/bin/bun" }));
    expect(found.kind).toBe("unknown");
    expect(found.kind === "unknown" && found.reason).toMatch(/no service definition/);
  });
});

describe("binaryIsReplaceable", () => {
  it("accepts a regular file in a writable directory", () => {
    const path = join(home, "subshell-server");
    writeFileSync(path, "#!/bin/sh\n");
    expect(binaryIsReplaceable(path)).toEqual({ ok: true });
  });

  it("accepts a read-only FILE, because the swap renames rather than writes", () => {
    const path = join(home, "subshell-server");
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o555);
    expect(binaryIsReplaceable(path).ok).toBe(true);
  });

  it("refuses a missing file, a directory, and an unwritable directory", () => {
    expect(binaryIsReplaceable(join(home, "nope")).ok).toBe(false);
    expect(binaryIsReplaceable(home).ok).toBe(false);

    const locked = join(home, "locked");
    mkdirSync(locked);
    const path = join(locked, "subshell-server");
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(locked, 0o555);
    const answer = binaryIsReplaceable(path);
    // Root ignores permission bits, so skip the assertion rather than fail a
    // container run (the same carve-out `uploads-route.test.ts` documents).
    if (process.getuid?.() !== 0) {
      expect(answer.ok).toBe(false);
      expect(answer.ok === false && answer.reason).toMatch(/not writable/);
    }
    chmodSync(locked, 0o755);
  });
});
