import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SupervisedProcessSpec } from "@internal/pane-runtime";
import {
  armProcess,
  disarmProcess,
  processState,
  type SpawnInput,
  type SupervisorDeps,
  setSupervisorDepsForTests,
  stopAllProcesses,
} from "@/services/network/supervisor.js";

/**
 * Nothing here spawns a process, waits a real second, or writes a real
 * credential: the whole state machine is driven through the deps seam. That is
 * what lets the backoff, the crash-loop park and the SIGTERM/SIGKILL sequence
 * be asserted as VALUES rather than as elapsed time.
 */

/** ANSI introducer, built rather than written, so this file holds no control characters. */
const ESC = String.fromCharCode(27);

/** A child the test exits by hand. */
class FakeChild {
  static nextPid = 1000;
  pid = FakeChild.nextPid++;
  signals: string[] = [];
  /** True once something reaped it, so a SIGTERM-ignoring child can be modelled. */
  reaped = false;
  /** When false, SIGTERM is swallowed and only SIGKILL ends it. */
  diesOnTerm = true;
  onLine: (line: string) => void = () => {};
  private settle!: (code: number | null) => void;
  exited = new Promise<number | null>((resolve) => {
    this.settle = resolve;
  });

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.diesOnTerm) this.exit(null);
  }

  /** Ends the child, as the OS would. */
  exit(code: number | null): void {
    if (this.reaped) return;
    this.reaped = true;
    this.settle(code);
  }
}

interface Harness {
  deps: SupervisorDeps;
  spawns: SpawnInput[];
  children: FakeChild[];
  /** Every duration the machine asked to wait, in order — backoff and the SIGTERM grace. */
  waits: number[];
  /** Advances the injected clock, for the uptime reset. */
  advance(ms: number): void;
}

function harness(overrides: Partial<SupervisorDeps> = {}): Harness {
  const spawns: SpawnInput[] = [];
  const children: FakeChild[] = [];
  const waits: number[] = [];
  let clock = 1_000_000;
  const deps: SupervisorDeps = {
    spawn: (input) => {
      spawns.push(input);
      const child = new FakeChild();
      child.onLine = input.onLine;
      children.push(child);
      return child;
    },
    secretFile: async (_id, name) => `/secrets/${name}`,
    secretValue: async () => "s3cr3t-value",
    extraPath: async () => ["/opt/homebrew/bin"],
    now: () => clock,
    // Instant, so the machine runs at test speed; the DURATION is asserted
    // from `waits` rather than from the wall clock.
    delay: async (ms) => {
      waits.push(ms);
    },
    ...overrides,
  };
  return {
    deps,
    spawns,
    children,
    waits,
    advance: (ms) => {
      clock += ms;
    },
  };
}

/** Lets the pending microtask/timer chain run to a quiescent point. */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Waits for a condition the run loop reaches asynchronously. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const spec: SupervisedProcessSpec = { command: "/usr/local/bin/tailscaled", args: ["--state=mem:"] };

beforeEach(() => {
  setSupervisorDepsForTests(harness().deps);
});

afterEach(() => {
  setSupervisorDepsForTests(null);
});

describe("supervisor: what reaches the child", () => {
  it("puts a secret's PATH in the argv and its VALUE in the environment, never the value in argv", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", {
      command: "/usr/local/bin/tailscaled",
      args: ["serve"],
      secretFileArgs: { "--token-file": "authkey" },
      secretEnv: { TS_AUTHKEY: "authkey" },
    });
    await until(() => h.spawns.length === 1, "the spawn");

    const { argv, env } = h.spawns[0];
    expect(argv).toEqual(["/usr/local/bin/tailscaled", "serve", "--token-file", "/secrets/authkey"]);
    // THE property this mechanism exists for: argv is `ps`-visible on this
    // host, so a credential reaches the child by file and environment only.
    // Asserted over the whole argv rather than the flag's neighbour.
    expect(argv.some((element) => element.includes("s3cr3t-value"))).toBe(false);
    expect(env.TS_AUTHKEY).toBe("s3cr3t-value");
  });

  it("gives the child an allowlisted environment with the probed PATH last", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    process.env.SUPERVISOR_TEST_LEAK = "must-not-appear";
    try {
      armProcess("tailscale", { ...spec, env: { PATH: "/attacker/bin", TS_DEBUG: "1" } });
      await until(() => h.spawns.length === 1, "the spawn");
      const { env } = h.spawns[0];
      expect(env.TS_DEBUG).toBe("1");
      // A plugin that could replace PATH would choose which binaries this host
      // finds, so PATH is applied after the plugin's extras, not before.
      expect(env.PATH).toContain("/opt/homebrew/bin");
      expect(env.PATH).not.toBe("/attacker/bin");
      // The allowlist, not `process.env`: this process holds BETTER_AUTH_SECRET
      // and the database path.
      expect(env.SUPERVISOR_TEST_LEAK).toBeUndefined();
      expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    } finally {
      delete process.env.SUPERVISOR_TEST_LEAK;
    }
  });
});

describe("supervisor: refusals", () => {
  it("refuses a command that is not an absolute path, and says so on the row", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", { command: "tailscaled", args: [] });
    await until(() => (processState("tailscale")?.lastLines.length ?? 0) > 0, "the refusal");

    expect(h.spawns).toHaveLength(0);
    const state = processState("tailscale");
    expect(state?.running).toBe(false);
    expect(state?.lastLines.join(" ")).toContain("absolute path");
    // Recorded rather than thrown: the caller is a boot, and a plugin's bad
    // spec must not be why the server does not come up.
    expect(state?.lastExit).toMatchObject({ code: null });
  });

  it("refuses a privilege wrapper, which this process has no terminal to answer", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    for (const command of ["/usr/bin/sudo", "/usr/bin/doas", "/usr/bin/pkexec"]) {
      const id = `plugin-${command.slice(9)}`;
      armProcess(id, { command, args: ["tailscaled"] });
      await until(() => (processState(id)?.lastLines.length ?? 0) > 0, `the refusal for ${command}`);
      expect(processState(id)?.lastLines.join(" ")).toContain("password prompt");
    }
    expect(h.spawns).toHaveLength(0);
  });

  it("refuses to start when a named secret is not set, rather than starting without it", async () => {
    const h = harness({ secretFile: async () => null });
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", { ...spec, secretFileArgs: { "--token-file": "authkey" } });
    await until(() => (processState("tailscale")?.lastLines.length ?? 0) > 0, "the refusal");

    expect(h.spawns).toHaveLength(0);
    // The vendor's own failure minutes later is what this replaces.
    expect(processState("tailscale")?.lastLines.join(" ")).toContain('secret "authkey" is not set');
  });
});

describe("supervisor: arming", () => {
  it("is idempotent — re-arming the same spec does not restart a working tunnel", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", spec);
    await until(() => h.spawns.length === 1, "the first spawn");
    armProcess("tailscale", { ...spec });
    armProcess("tailscale", { command: spec.command, args: ["--state=mem:"], env: {} });
    await settle();

    expect(h.spawns).toHaveLength(1);
    expect(h.children[0].signals).toEqual([]);
  });

  it("respawns when the spec changes, stopping the old child first", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", spec);
    await until(() => h.spawns.length === 1, "the first spawn");
    armProcess("tailscale", { ...spec, args: ["--state=/var/lib/tailscale"] });
    await until(() => h.spawns.length === 2, "the replacement spawn");

    // Two daemons would compete for one publish, so the old one is reaped
    // before the new one starts.
    expect(h.children[0].signals[0]).toBe("SIGTERM");
    expect(h.children[0].reaped).toBe(true);
    expect(h.spawns[1].argv).toEqual(["/usr/local/bin/tailscaled", "--state=/var/lib/tailscale"]);
  });

  it("reports a live-but-not-ready child as running:false with a pid, until its readyPattern matches", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", { ...spec, readyPattern: "listening on" });
    await until(() => h.spawns.length === 1, "the spawn");

    // Alive, not ready: reporting this as running would make the page lie
    // during the exact seconds an operator is watching it.
    expect(processState("tailscale")?.running).toBe(false);
    expect(processState("tailscale")?.pid).toBe(h.children[0].pid);

    h.children[0].onLine("2026-09-15 listening on 127.0.0.1:8080");
    expect(processState("tailscale")?.running).toBe(true);
    // Only ever flips on: a daemon that logs traffic after its ready line has
    // not become un-ready.
    h.children[0].onLine("handled a request");
    expect(processState("tailscale")?.running).toBe(true);
  });

  it("keeps at most twenty output lines, ANSI stripped", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", spec);
    await until(() => h.spawns.length === 1, "the spawn");
    for (let i = 0; i < 25; i++) h.children[0].onLine(`${ESC}[32mline ${i}${ESC}[0m`);

    const lines = processState("tailscale")?.lastLines ?? [];
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("line 5");
    expect(lines.join("")).not.toContain(ESC);
  });
});

describe("supervisor: restarts", () => {
  it("backs off from one second, doubling to a sixty-second ceiling", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", spec);

    for (let i = 0; i < 8; i++) {
      await until(() => h.children.length === i + 1, `spawn ${i + 1}`);
      h.children[i].exit(1);
      await settle(2);
    }
    expect(h.waits.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(processState("tailscale")?.restarts).toBe(8);
    expect(processState("tailscale")?.lastExit).toMatchObject({ code: 1 });
  });

  it("resets the backoff after five minutes of uptime", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", spec);
    await until(() => h.children.length === 1, "the first spawn");
    h.children[0].exit(1);
    await until(() => h.children.length === 2, "the second spawn");
    expect(h.waits).toEqual([1000]);

    // This one worked. A process restarted once a day would otherwise reach
    // the ceiling — and the park threshold — over a long-lived instance.
    h.advance(6 * 60 * 1000);
    h.children[1].exit(1);
    await until(() => h.children.length === 3, "the third spawn");
    expect(h.waits).toEqual([1000, 1000]);
  });

  it("parks after more than ten restarts inside ten minutes, and keeps the row", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", spec);

    for (let i = 0; i < 11; i++) {
      await until(() => h.children.length === i + 1, `spawn ${i + 1}`);
      h.children[i].exit(1);
      await settle(2);
    }
    await settle();

    // Eleven exits inside the window: the eleventh parks, so no twelfth child
    // is ever spawned.
    expect(h.children).toHaveLength(11);
    const state = processState("tailscale");
    expect(state?.running).toBe(false);
    expect(state?.lastLines.join(" ")).toContain("parked");
    // Parked, NOT disarmed — the row is where the operator reads the reason.
    expect(state).not.toBeNull();
  });

  it("re-arming a parked entry starts it again", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", spec);
    for (let i = 0; i < 11; i++) {
      await until(() => h.children.length === i + 1, `spawn ${i + 1}`);
      h.children[i].exit(1);
      await settle(2);
    }
    await settle();

    // Parking is the host giving up; an operator asking again clears it, even
    // with a byte-identical spec.
    armProcess("tailscale", spec);
    await until(() => h.children.length === 12, "the post-park spawn");
  });
});

describe("supervisor: stopping", () => {
  it("disarms with SIGTERM and resolves only once the child is reaped", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", spec);
    await until(() => h.children.length === 1, "the spawn");

    await disarmProcess("tailscale");
    expect(h.children[0].signals).toEqual(["SIGTERM"]);
    expect(h.children[0].reaped).toBe(true);
    expect(processState("tailscale")).toBeNull();
    // A disarm during the child's life must not leave the loop respawning.
    await settle();
    expect(h.children).toHaveLength(1);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", spec);
    await until(() => h.children.length === 1, "the spawn");
    h.children[0].diesOnTerm = false;

    await disarmProcess("tailscale");
    expect(h.children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.children[0].reaped).toBe(true);
    // The grace is a real duration, asserted as a value.
    expect(h.waits).toContain(5000);
  });

  it("does not respawn a child that was disarmed", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", spec);
    await until(() => h.children.length === 1, "the spawn");
    await disarmProcess("tailscale");
    await settle();

    expect(h.children).toHaveLength(1);
    expect(processState("tailscale")).toBeNull();
  });

  it("disarming something that was never armed is not an error", async () => {
    await disarmProcess("never-armed");
    expect(processState("never-armed")).toBeNull();
  });

  it("stopAllProcesses reaps every child", async () => {
    const h = harness();
    setSupervisorDepsForTests(h.deps);
    armProcess("tailscale", spec);
    armProcess("cloudflare", { command: "/usr/local/bin/cloudflared", args: ["tunnel", "run"] });
    await until(() => h.children.length === 2, "both spawns");

    await stopAllProcesses();
    expect(h.children.every((child) => child.reaped)).toBe(true);
    expect(processState("tailscale")).toBeNull();
    expect(processState("cloudflare")).toBeNull();
  });
});
