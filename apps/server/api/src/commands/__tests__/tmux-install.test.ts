import { describe, expect, test } from "bun:test";
import { chooseTmuxInstaller, HOMEBREW_INSTALL_URL, runTmuxInstall } from "../tmux-install.js";

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
    });
  });

  test("darwin with NEITHER → the Homebrew bootstrap: the one route that may install a package manager", () => {
    const installer = chooseTmuxInstaller({ platform: "darwin", which: whichWith("apt-get") });
    // The old rule was `null` here ("Homebrew is never bootstrapped"); the
    // operator addendum of 2026-09-26 replaced it with this offer, whose argv
    // is Homebrew's OWN documented installer, run on their infra.
    expect(installer?.label).toBe("Homebrew");
    expect(installer?.argv).toEqual(["/bin/bash", "-c", `$(curl -fsSL ${HOMEBREW_INSTALL_URL})`]);
    // The refusal half of this offer is its reason to exist: a route with no
    // terminal must never fire it, because the child's admin password can
    // only be typed on one.
    expect(installer?.needsTerminal).toBe(true);
    expect(installer?.manual).toContain("brew install tmux");
    expect(installer?.manual).toContain(HOMEBREW_INSTALL_URL);
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
