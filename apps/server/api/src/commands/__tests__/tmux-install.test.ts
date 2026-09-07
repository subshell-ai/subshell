import { describe, expect, test } from "bun:test";
import { chooseTmuxInstaller, runTmuxInstall } from "../tmux-install.js";

/**
 * The offer-to-install detector + runner (spec 2026-09-03 tmux offer), pinned
 * as pure functions: no spawn ever happens in here — the runner's `spawn` is
 * always injected.
 */

function whichWith(...names: string[]): (n: string) => string | null {
  return (n: string) => (names.includes(n) ? `/usr/bin/${n}` : null);
}

describe("chooseTmuxInstaller", () => {
  test("darwin with brew → brew install, no sudo front", () => {
    expect(chooseTmuxInstaller({ platform: "darwin", which: whichWith("brew") })).toEqual({
      argv: ["brew", "install", "tmux"],
      label: "brew",
    });
  });

  test("darwin without brew → null (we do not bootstrap Homebrew)", () => {
    expect(chooseTmuxInstaller({ platform: "darwin", which: whichWith("apt-get") })).toBeNull();
  });

  test("linux with apt-get → sudo apt-get install -y", () => {
    expect(chooseTmuxInstaller({ platform: "linux", which: whichWith("apt-get", "dnf") })).toEqual({
      argv: ["sudo", "apt-get", "install", "-y", "tmux"],
      label: "apt-get",
    });
  });

  test("linux with dnf only → sudo dnf install -y", () => {
    expect(chooseTmuxInstaller({ platform: "linux", which: whichWith("dnf") })).toEqual({
      argv: ["sudo", "dnf", "install", "-y", "tmux"],
      label: "dnf",
    });
  });

  test("linux with neither package manager → null", () => {
    expect(chooseTmuxInstaller({ platform: "linux", which: whichWith("pacman") })).toBeNull();
  });

  test("any other platform → null", () => {
    expect(chooseTmuxInstaller({ platform: "win32", which: whichWith("brew", "apt-get", "dnf") })).toBeNull();
  });
});

describe("runTmuxInstall", () => {
  const installer = { argv: ["brew", "install", "tmux"], label: "brew" } as const;

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
