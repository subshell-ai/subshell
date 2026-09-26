import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapArgv, chooseTmuxInstaller, HOMEBREW_INSTALL_URL, runTmuxInstall } from "../tmux-install.js";

/**
 * The offer-to-install detector + runner (spec 2026-09-03 tmux offer), pinned
 * as pure functions: no spawn ever happens in here — the runner's `spawn` is
 * always injected.
 *
 * macOS detection became three-way on 2026-09-26 (operator addendum): brew,
 * then MacPorts, then a Homebrew BOOTSTRAP offer. The bootstrap is the one
 * route allowed to install a package manager, and it is the one entry that
 * needs a terminal (its own sudo prompt), which is what `needsTerminal` is
 * for: the gates refuse to run it where no password could ever be typed.
 */

function whichWith(...names: string[]): (n: string) => string | null {
  return (n: string) => (names.includes(n) ? `/usr/bin/${n}` : null);
}

describe("chooseTmuxInstaller", () => {
  test("darwin with brew → brew install, no sudo front", () => {
    expect(chooseTmuxInstaller({ platform: "darwin", which: whichWith("brew") })).toEqual({
      argv: ["brew", "install", "tmux"],
      label: "brew",
      manual: "brew install tmux",
    });
  });

  test("darwin with brew AND MacPorts → brew wins", () => {
    expect(chooseTmuxInstaller({ platform: "darwin", which: whichWith("brew", "port") })).toEqual({
      argv: ["brew", "install", "tmux"],
      label: "brew",
      manual: "brew install tmux",
    });
  });

  test("darwin with MacPorts, no brew → port install tmux (2026-09-26 addendum)", () => {
    expect(chooseTmuxInstaller({ platform: "darwin", which: whichWith("port") })).toEqual({
      argv: ["port", "install", "tmux"],
      label: "MacPorts",
      manual: "sudo port install tmux",
      // Asserted ON THE FLAG, not the label string (review 2026-09-26): the
      // terminal-less gates read `needsTerminal`, so renaming the display
      // label cannot re-admit `port` to a place that can never answer its
      // self-escalation password. `port` carries no sudo in the PARENT argv
      // (it self-escalates through portsudoers) — that is exactly why the
      // flag, not argv[0], is what marks it.
      needsTerminal: true,
    });
  });

  test("darwin with NEITHER → the Homebrew bootstrap: the one route that may install a package manager", () => {
    const installer = chooseTmuxInstaller({ platform: "darwin", which: whichWith("apt-get") });
    // The old rule was `null` here ("Homebrew is never bootstrapped"); the
    // operator addendum of 2026-09-26 replaced it with this offer, whose argv
    // is Homebrew's OWN documented installer, run on their infra.
    expect(installer?.label).toBe("Homebrew");
    // The PIPE form (review 2026-09-26 Critical): the original
    // `$(curl …)`-unquoted shape word-split the script text and execed its
    // first field (the shebang) — 127, measured. The canary below keeps that
    // reason executable; the run-the-shape test below proves THIS one runs.
    expect(installer?.argv).toEqual(bootstrapArgv(HOMEBREW_INSTALL_URL));
    expect(installer?.argv).toEqual(["/bin/bash", "-c", `curl -fsSL ${HOMEBREW_INSTALL_URL} | bash`]);
    // The refusal half of this offer is its reason to exist: a route with no
    // terminal must never fire it, because the child's admin password can
    // only be typed on one.
    expect(installer?.needsTerminal).toBe(true);
    expect(installer?.manual).toContain("brew install tmux");
    expect(installer?.manual).toContain(HOMEBREW_INSTALL_URL);
  });

  test("the bootstrap URL is injectable through the io seam (nothing test-shaped reads the compiled-in constant)", () => {
    const installer = chooseTmuxInstaller({
      platform: "darwin",
      which: () => null,
      bootstrapUrl: "http://127.0.0.1:9/install.sh",
    });
    expect(installer?.argv).toEqual(["/bin/bash", "-c", "curl -fsSL http://127.0.0.1:9/install.sh | bash"]);
  });

  test("linux with apt-get → sudo apt-get install -y", () => {
    expect(chooseTmuxInstaller({ platform: "linux", which: whichWith("apt-get", "dnf") })).toEqual({
      argv: ["sudo", "apt-get", "install", "-y", "tmux"],
      label: "apt-get",
      manual: "apt install tmux",
    });
  });

  test("linux with dnf only → sudo dnf install -y", () => {
    expect(chooseTmuxInstaller({ platform: "linux", which: whichWith("dnf") })).toEqual({
      argv: ["sudo", "dnf", "install", "-y", "tmux"],
      label: "dnf",
      manual: "dnf install tmux",
    });
  });

  test("linux with neither package manager → null (the ladder is unchanged by the addendum)", () => {
    expect(chooseTmuxInstaller({ platform: "linux", which: whichWith("pacman") })).toBeNull();
  });

  test("any other platform → null", () => {
    expect(chooseTmuxInstaller({ platform: "win32", which: whichWith("brew", "apt-get", "dnf") })).toBeNull();
  });

  /**
   * The rename-proof pin (review 2026-09-26 Minor 6, exact shape). The
   * terminal-less gates read `needsTerminal`, so EVERY macOS row the ladder
   * can actually pick must be either brew (the one unprivileged route) or
   * flagged. Exhaustive against the REAL table: the names the function probes
   * are captured from the probe itself, so a future third row, keyed on a
   * name invented later, is in the set on the day it lands — and fails here
   * if it arrives unflagged. A renamed MacPorts cannot dodge this either:
   * the assertion is on the flag, never the label.
   */
  test("EXHAUSTIVE: every non-brew macOS row in the real table carries needsTerminal", () => {
    const probed: string[] = [];
    chooseTmuxInstaller({
      platform: "darwin",
      which: (n) => {
        probed.push(n);
        return null;
      },
    });
    const rows = [null, ...probed].map((only) =>
      chooseTmuxInstaller({ platform: "darwin", which: (n) => (n === only ? `/usr/bin/${n}` : null) }),
    );
    expect(rows.length).toBe(probed.length + 1); // every probe + the all-absent row
    for (const row of rows) {
      if (row?.label === "brew") continue; // the one row the terminal-less gates DO run
      expect(row?.needsTerminal, `row '${row?.label}' must carry the flag`).toBe(true);
    }
  });
});

describe("runTmuxInstall", () => {
  const installer = { argv: ["brew", "install", "tmux"], label: "brew", manual: "brew install tmux" } as const;

  test("exit 0 + tmux now findable → the found path", () => {
    let spawned: readonly string[] | undefined;
    const found = runTmuxInstall(installer, {
      spawn: (argv) => {
        spawned = argv;
        return 0;
      },
      which: (n) => (n === "tmux" ? "/opt/homebrew/bin/tmux" : null),
    });
    expect(found).toBe("/opt/homebrew/bin/tmux");
    expect(spawned).toEqual(["brew", "install", "tmux"]);
  });

  test("a supplied stdin fd reaches the spawn (the swapped run's installer answers its password on the ATTACHED tty, not the drained pipe)", () => {
    const seen: { argv: readonly string[]; stdin: number | undefined }[] = [];
    runTmuxInstall(installer, {
      spawn: (argv, stdin) => {
        seen.push({ argv, stdin });
        return 0;
      },
      which: () => "/usr/bin/tmux",
      stdin: 7,
    });
    expect(seen).toEqual([{ argv: ["brew", "install", "tmux"], stdin: 7 }]);
  });

  test("exit 0 but tmux STILL not findable → null (PATH caveat; never continue broken)", () => {
    expect(runTmuxInstall(installer, { spawn: () => 0, which: () => null })).toBeNull();
  });

  test("non-zero exit → null", () => {
    expect(runTmuxInstall(installer, { spawn: () => 1, which: () => "/usr/bin/tmux" })).toBeNull();
  });

  test("spawn throws (sudo vanished mid-argv) → null, not a crash", () => {
    expect(
      runTmuxInstall(installer, {
        spawn: () => {
          throw new Error("spawn failed");
        },
        which: () => "/usr/bin/tmux",
      }),
    ).toBeNull();
  });

  test("spawn throw is SURFACED through note with the argv + reason (bun throws ENOENT pre-output)", () => {
    const notes: string[] = [];
    expect(
      runTmuxInstall(installer, {
        spawn: () => {
          throw new Error("ENOENT: no such file or directory, posix_spawn 'sudo'");
        },
        which: () => null,
        note: (line) => void notes.push(line),
      }),
    ).toBeNull();
    expect(notes.join("\n")).toContain("brew install tmux");
    expect(notes.join("\n")).toMatch(/ENOENT/);
  });
});

/**
 * THE bootstrap argv form, EXECUTED (review 2026-09-26 Critical 1). The old
 * shape `bash -c "$(curl …)"` passed WITHOUT the outer double quotes word-
 * split the command substitution's result and execed its first field, which
 * for any real install script is its `#!/bin/bash` line — exit 127, measured
 * by the reviewer. A string-equality pin could never have caught that, so
 * this runs the actual argv against a localhost stub serving a SHEBANG-FIRST
 * script and asserts the script's marker lands; the canary then runs the old
 * shape against the same stub and pins that it does NOT work, which is the
 * whole reason the pipe form exists.
 */
describe("bootstrap argv shape, executed", () => {
  function stubServer(script: string): { url: string; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(script, { headers: { "content-type": "text/plain" } }),
    });
    return { url: `http://127.0.0.1:${server.port}/install.sh`, stop: () => server.stop() };
  }

  test("the table's argv runs a shebang-first script end to end (marker lands)", async () => {
    const dir = mkdtempSync(join(tmpdir(), `subshell-boot-argv-${process.pid}-`));
    const marker = join(dir, "ran.marker");
    const stub = stubServer(`#!/bin/bash\n# a script whose FIRST line is a shebang\necho ran > ${marker}\n`);
    try {
      const chosen = chooseTmuxInstaller({ platform: "darwin", which: () => null, bootstrapUrl: stub.url });
      if (!chosen) throw new Error("the darwin ladder must yield an installer");
      // ASYNC on purpose: the stub server lives on THIS process's event loop,
      // and a spawnSync would block the very loop that has to answer curl
      // (measured: 30 s hang). Awaited, the child runs and the loop serves.
      const child = Bun.spawn({
        cmd: [...chosen.argv],
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      const code = await child.exited;
      expect(code).toBe(0);
      expect(readFileSync(marker, "utf8").trim()).toBe("ran");
    } finally {
      stub.stop();
    }
  });

  test("canary: the REJECTED `$(curl …)` shape fails on the same script (why the pipe form exists)", async () => {
    const dir = mkdtempSync(join(tmpdir(), `subshell-boot-canary-${process.pid}-`));
    const marker = join(dir, "ran.marker");
    const stub = stubServer(`#!/bin/bash\necho ran > ${marker}\n`);
    try {
      const child = Bun.spawn({
        cmd: ["/bin/bash", "-c", `$(curl -fsSL ${stub.url})`],
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      const code = await child.exited;
      expect(code).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      stub.stop();
    }
  });
});
