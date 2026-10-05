import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  controlStateFor,
  initTerminalForLaunch,
  readTerminalLog,
  readTerminalState,
  rotateTerminalLogIfNeeded,
  terminalLogPath,
  transitionControl,
} from "../ssh-terminal-log.js";
import { cleanup, makeRunId, tempRoot } from "./helpers.js";

/**
 * The managed-terminal contract (§3): takeover/return RAISES the input
 * generation and the node refuses transitions that would LOWER it; the log
 * rotates with generation + byte offset and a stale cursor gets an explicit
 * cursor-expired, never a silent re-anchor. State persists (temp+rename 0600)
 * because panes outlive the daemon.
 */

let root: string;
let dataDir: string;

beforeAll(() => {
  root = tempRoot("subshell-ssh-termlog-");
  dataDir = join(root, "data");
  mkdirSync(join(dataDir, "subshells"), { recursive: true });
});

afterAll(() => cleanup(root));

const id = makeRunId(1); // subshell ids share the grammar

describe("control state", () => {
  it("transitions move mode and generation and persist", () => {
    const t = transitionControl(dataDir, id, "human", 5);
    expect(t.kind).toBe("applied");
    if (t.kind === "applied") expect(t.state).toEqual({ mode: "human", generation: 5, logGeneration: 1 });
    expect(controlStateFor(dataDir, id)).toEqual({ mode: "human", generation: 5 });
    expect(readTerminalState(dataDir, id)?.generation).toBe(5);
  });

  it("a replayed LOWER generation is refused with the frozen stale signal (the shape the agent maps to the constant)", () => {
    const stale = transitionControl(dataDir, id, "agent", 4);
    expect(stale.kind).toBe("stale");
    if (stale.kind === "stale") expect(stale.state.mode).toBe("human");
    expect(controlStateFor(dataDir, id)).toEqual({ mode: "human", generation: 5 });
  });

  it("equal generation re-asserts mode idempotently (the echo is what lets the plane detect a lost race)", () => {
    const t = transitionControl(dataDir, id, "agent", 5);
    expect(t.kind).toBe("applied");
    if (t.kind === "applied") expect(t.state).toEqual({ mode: "agent", generation: 5, logGeneration: 1 });
  });

  it("launch keeps control state but bumps the log generation (a new session is a new log)", () => {
    const st = initTerminalForLaunch(dataDir, id);
    expect(st.mode).toBe("agent");
    expect(st.generation).toBe(5);
    expect(st.logGeneration).toBe(2);
    expect(lstatSync(join(dataDir, "ssh", "terminals", `${id}.json`)).mode & 0o777).toBe(0o600);
  });

  it("an unknown pane has no control state (null, not a default)", () => {
    expect(controlStateFor(dataDir, makeRunId(4242))).toBeNull();
    expect(readTerminalState(dataDir, "not-an-id/")).toBeNull();
  });
});

describe("bounded rotation and cursor honesty", () => {
  const rid = makeRunId(2);
  const logPath = () => terminalLogPath(dataDir, rid);

  it("reads serve the current generation and refuse stale ones", () => {
    const st = initTerminalForLaunch(dataDir, rid); // gen 1 here (fresh pane)
    writeFileSync(logPath(), "0123456789");
    const ok = readTerminalLog(dataDir, rid, st.logGeneration, 2, 5);
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") {
      expect(ok.bytes.toString()).toBe("23456");
      expect(ok.nextByte).toBe(7);
      expect(ok.size).toBe(10);
    }
    const stale = readTerminalLog(dataDir, rid, st.logGeneration - 1, 2, 5);
    expect(stale.status).toBe("cursor-expired");
    if (stale.status === "cursor-expired") expect(stale.generation).toBe(st.logGeneration);
    const past = readTerminalLog(dataDir, rid, st.logGeneration, 99, 5);
    expect(past.status).toBe("cursor-expired"); // a cursor past EOF means the file was reset under it
  });

  it("rotation renames ONE segment, bumps the generation, and old cursors come back expired", () => {
    // continuation of the previous test: generation 1, the 10-byte log from it.
    writeFileSync(logPath(), "x".repeat(50));
    expect(rotateTerminalLogIfNeeded(dataDir, rid, 60)).toBeNull(); // under the cap: no rotation
    const rotated = rotateTerminalLogIfNeeded(dataDir, rid, 10);
    expect(rotated).not.toBeNull();
    expect(rotated?.logGeneration).toBe(2);
    expect(readFileSync(`${logPath()}.1`, "utf8")).toBe("x".repeat(50));
    // the pane keeps appending to a FRESH log (re-armed child); the old cursor is now stale:
    const before = readTerminalLog(dataDir, rid, 1, 0, 100);
    expect(before.status).toBe("cursor-expired");
    if (before.status === "cursor-expired") expect(before.generation).toBe(2);
    writeFileSync(logPath(), "fresh");
    const after = readTerminalLog(dataDir, rid, 2, 0, 100);
    expect(after.status === "ok" && after.bytes.toString()).toBe("fresh");
  });

  it("the second rotation replaces the previous segment (bounded: one rotated file)", () => {
    writeFileSync(logPath(), "y".repeat(30));
    const r2 = rotateTerminalLogIfNeeded(dataDir, rid, 10);
    expect(r2?.logGeneration).toBe(3);
    expect(readFileSync(`${logPath()}.1`, "utf8")).toBe("y".repeat(30)); // the `fresh` segment is gone
  });

  it("a symlink at the log name is refused, never renamed or read through", () => {
    const sid = makeRunId(3);
    initTerminalForLaunch(dataDir, sid);
    const outside = join(root, "log-victim.txt");
    writeFileSync(outside, "secret-scrollback");
    symlinkSync(outside, terminalLogPath(dataDir, sid));
    expect(rotateTerminalLogIfNeeded(dataDir, sid, 0)).toBeNull();
    const rd = readTerminalLog(dataDir, sid, readTerminalState(dataDir, sid)!.logGeneration, 0, 100);
    expect(rd.status === "ok" ? rd.bytes.length : 0).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("secret-scrollback");
  });
});
