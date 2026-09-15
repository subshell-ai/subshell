import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServerVersion, runUpdate, type UpdateDeps, type UpdateOpts } from "@/commands/update.js";
import type { ServiceDeps } from "@/service.js";
import type { InstalledBinary } from "@/services/installed-binary.js";
import { beginUpdate, readPending, updateDir } from "@/services/update-transaction.js";
import { SERVER_VERSION } from "@/version.js";

/**
 * Everything here drives the verb with NO network, NO service manager and NO
 * real binary: `--from` is the path that needs none of them, and the version
 * probe is the one seam that decides what a file "is".
 *
 * The release path is covered in `services/__tests__/releases.test.ts` against
 * a real fake release server; what is left for this suite is the refusals and
 * the transaction, which is where the verb's whole value sits.
 */
let work = "";
let binary = "";
let incoming = "";
let logs: string[] = [];
let errors: string[] = [];
let restored: string[] = [];

/** A service manager that reports nothing installed, so no restart is attempted. */
function serviceStub(over: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    platform: "linux",
    home: work,
    uid: 1000,
    servicePath: binary,
    argv1: "",
    configDir: join(work, "config"),
    env: {},
    which: () => null,
    hasConfig: () => true,
    runCmd: () => ({ code: 1, out: "", err: "no manager" }),
    writeFile: () => {},
    removeFile: () => {},
    fileExists: () => false,
    readFile: () => null,
    ...over,
  };
}

function deps(over: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
    confirm: async () => true,
    isTTY: false,
    service: serviceStub(),
    installed: (): InstalledBinary => ({ kind: "compiled", path: binary, source: "this process" }),
    // The incoming file says 9.9.9; the installed one says whatever this build is.
    probeVersion: (file) => (file === binary ? SERVER_VERSION : "9.9.9"),
    // The database seams are stubbed for a reason worth stating: the whole
    // suite shares ONE database in ONE process, so a real snapshot-and-restore
    // here would delete the file every other test file is holding open (it
    // did, measured 2026-09-15 — 136 `SQLITE_IOERR_VNODE` failures).
    backup: async () => ({ path: join(work, "snapshot.db") }),
    restore: (path) => restored.push(path),
    ...over,
  };
}

const run = (opts: UpdateOpts, over: Partial<UpdateDeps> = {}) => runUpdate(opts, deps(over));

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "update-cmd-"));
  mkdirSync(join(work, "config"), { recursive: true });
  binary = join(work, "subshell-server");
  incoming = join(work, "incoming-subshell-server");
  writeFileSync(binary, "the installed binary");
  chmodSync(binary, 0o755);
  writeFileSync(incoming, "the new binary");
  logs = [];
  errors = [];
  restored = [];
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(updateDir(), { recursive: true, force: true });
});

describe("parseServerVersion", () => {
  it("reads the byte-identical `version` contract and nothing looser", () => {
    expect(parseServerVersion("subshell-server 0.6.0\n")).toBe("0.6.0");
    // Not the agent's line, not a prefix match, not a prerelease.
    expect(parseServerVersion("subshell 0.6.0")).toBeNull();
    expect(parseServerVersion("subshell-server v0.6.0")).toBeNull();
    expect(parseServerVersion("subshell-server 0.6.0-rc.1")).toBeNull();
    expect(parseServerVersion("")).toBeNull();
  });
});

describe("update — where the binary is", () => {
  it("refuses a checkout by name, quoting both tokens", async () => {
    // A dev-form install's first token is `bun`; replacing it would overwrite
    // the interpreter, which is the trap `server_bin.rs` names.
    const code = await run(
      {},
      {
        installed: () => ({
          kind: "source",
          argv: ["/usr/bin/bun", "/repo/src/index.ts"],
          source: "service definition",
          reason: "this server runs from a checkout; update it with git",
        }),
      },
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/checkout/);
    expect(errors.join("\n")).toContain("/usr/bin/bun");
  });

  it("refuses when nothing on this host names a binary", async () => {
    expect(
      await run({}, { installed: () => ({ kind: "unknown", reason: "no service definition names a binary" }) }),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/no service definition/);
  });

  it("refuses a binary whose directory is not writable", async () => {
    // The swap is two renames in one directory, so the DIRECTORY is what has
    // to be writable — and saying which one is what makes the refusal useful.
    expect(
      await run(
        {},
        { installed: () => ({ kind: "compiled", path: "/nowhere/subshell-server", source: "this process" }) },
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/cannot replace/);
  });
});

describe("update --from", () => {
  it("refuses a file that is not there", async () => {
    expect(await run({ from: join(work, "missing") })).toBe(1);
    expect(errors.join("\n")).toMatch(/is not there/);
  });

  it("refuses a file that cannot say what it is", async () => {
    // There is no digest to check on a local file, so what it SAYS is the only
    // evidence — and something that answers nothing is not installable.
    expect(await run({ from: incoming }, { probeVersion: () => null })).toBe(1);
    expect(errors.join("\n")).toMatch(/did not answer/);
  });

  it("does nothing when the file is the version already installed", async () => {
    expect(await run({ from: incoming }, { probeVersion: () => SERVER_VERSION })).toBe(0);
    expect(logs.join("\n")).toContain(`Already at ${SERVER_VERSION}`);
    expect(readFileSync(binary, "utf8")).toBe("the installed binary");
  });

  it("refuses a downgrade without --force", async () => {
    expect(await run({ from: incoming }, { probeVersion: (f) => (f === binary ? SERVER_VERSION : "0.0.1") })).toBe(1);
    expect(errors.join("\n")).toMatch(/older than the running/);
  });

  it("swaps the binary, keeps .previous, and leaves the marker for the next boot", async () => {
    expect(await run({ from: incoming, yes: true, noRestart: true })).toBe(0);
    expect(readFileSync(binary, "utf8")).toBe("the new binary");
    expect(readFileSync(`${binary}.previous`, "utf8")).toBe("the installed binary");
    // The transaction is OPEN: the new binary's own boot is what completes or
    // reverts it, which is what makes the CLI and the dashboard one path.
    const pending = readPending();
    expect(pending?.from).toBe(SERVER_VERSION);
    expect(pending?.to).toBe("9.9.9");
    expect(pending?.binary).toBe(binary);
    expect(pending?.origin).toBe("cli");
  });

  it("refuses to start a second transaction while one is open", async () => {
    beginUpdate({
      from: "0.1.0",
      to: "0.2.0",
      binary,
      previousBinary: `${binary}.previous`,
      backup: null,
      startedAt: new Date().toISOString(),
      origin: "cli",
      forced: false,
    });
    expect(await run({ from: incoming, yes: true, noRestart: true })).toBe(1);
    expect(errors.join("\n")).toMatch(/--rollback/);
    // And the binary was NOT touched.
    expect(readFileSync(binary, "utf8")).toBe("the installed binary");
  });

  it("stops without touching anything when the confirmation is declined", async () => {
    expect(await run({ from: incoming }, { isTTY: true, confirm: async () => false })).toBe(0);
    expect(readFileSync(binary, "utf8")).toBe("the installed binary");
    expect(readPending()).toBeNull();
  });

  it("refuses when the binary reports a version other than the one probed", async () => {
    // The digest proves the bytes are the ones the release published; it does
    // not prove the release was labelled right.
    let first = true;
    expect(
      await run(
        { from: incoming, yes: true, noRestart: true },
        {
          probeVersion: (file) => {
            if (file === binary) return SERVER_VERSION;
            // The pre-install probe says 9.9.9; the post-copy one disagrees.
            if (first) {
              first = false;
              return "9.9.9";
            }
            return "6.6.6";
          },
        },
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/reports 6\.6\.6, not 9\.9\.9/);
    expect(readFileSync(binary, "utf8")).toBe("the installed binary");
    expect(readPending()).toBeNull();
  });
});

describe("update --check", () => {
  it("reports without installing", async () => {
    expect(await run({ from: incoming, check: true, json: true })).toBe(0);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      installed: SERVER_VERSION,
      latest: "9.9.9",
      updateAvailable: true,
    });
    expect(readFileSync(binary, "utf8")).toBe("the installed binary");
  });

  it("says so in prose without --json", async () => {
    expect(await run({ from: incoming, check: true })).toBe(0);
    expect(logs.join("\n")).toContain("9.9.9 is available");
  });
});

describe("update --rollback", () => {
  it("refuses when there is nothing to roll back to", async () => {
    expect(await run({ rollback: true, yes: true })).toBe(1);
    expect(errors.join("\n")).toMatch(/nothing to roll back to/);
  });

  it("puts the previous binary back and clears the marker", async () => {
    await run({ from: incoming, yes: true, noRestart: true });
    expect(readFileSync(binary, "utf8")).toBe("the new binary");

    expect(await run({ rollback: true, yes: true })).toBe(0);
    expect(readFileSync(binary, "utf8")).toBe("the installed binary");
    expect(existsSync(`${binary}.previous`)).toBe(false);
    expect(readPending()).toBeNull();
    // The database the marker named comes back with the binary — putting only
    // the binary back leaves a server that cannot boot at all (§12.3).
    expect(restored).toEqual([join(work, "snapshot.db")]);
  });
});
