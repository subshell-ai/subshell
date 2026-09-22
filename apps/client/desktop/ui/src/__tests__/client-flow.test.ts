import { describe, expect, it } from "bun:test";
import {
  clientScreen,
  configured,
  type FteStep,
  type RegisterPhase,
  railActive,
  railFor,
  registerSteps,
} from "@/lib/client-flow";
import type { NodeSettings, Probe, ProbeStep } from "@/lib/ipc";

const settings = (planeUrl: string | null): NodeSettings => ({
  nodeBinPath: null,
  planes: planeUrl === null ? [] : [planeUrl],
});

/** A machine with tmux and nothing else — the true first run, unless told otherwise. */
const probe = (over: Partial<Probe> = {}): Probe => ({ step: "no-node", tmux: "/usr/bin/tmux", ...over }) as Probe;

/** An enrolled machine: a node config exists, so `status` names a node. */
const enrolled = (step: ProbeStep): Probe => probe({ step, status: { nodeId: "n1", serverUrl: "https://plane.test" } });

describe("configured", () => {
  it("is a stored plane address, which Rust already folded an enrolled node's own server into", () => {
    expect(configured(settings("https://plane.test"), undefined)).toBe(true);
    expect(configured(settings(null), undefined)).toBe(false);
    expect(configured(undefined, undefined)).toBe(false);
  });

  it("also counts an enrolled machine whose stored address would not parse", () => {
    // `plane_url_from` SKIPS an address that fails validation, so a machine
    // enrolled against something it cannot re-validate has a node config and
    // no `planeUrl`. It is still not a machine to walk through a first run —
    // that walk ends at Register, which would re-enroll it.
    expect(configured(settings(null), enrolled("online"))).toBe(true);
    expect(configured(settings(null), probe({ step: "not-enrolled" }))).toBe(false);
  });
});

describe("clientScreen", () => {
  it("is null while the app's own settings have not been read", () => {
    expect(clientScreen({ step: null, override: null })).toBeNull();
    expect(clientScreen({ probe: probe(), step: null, override: null })).toBeNull();
  });

  it("opens an untouched machine on Welcome", () => {
    expect(clientScreen({ probe: probe(), settings: settings(null), step: null, override: null })).toBe("welcome");
    expect(clientScreen({ settings: settings(null), step: null, override: null })).toBe("welcome");
    expect(clientScreen({ probe: probe(), settings: settings(null), step: "intro", override: null })).toBe("welcome");
  });

  it("asks what the person came to do", () => {
    expect(clientScreen({ probe: probe(), settings: settings(null), step: "choice", override: null })).toBe("choice");
  });

  it("sends the watch path to the one screen that asks for an address", () => {
    expect(clientScreen({ probe: probe(), settings: settings(null), step: "watch", override: null })).toBe("connect");
  });

  it("gates the node path on tmux, and fails closed when the probe has not answered", () => {
    expect(clientScreen({ probe: probe({ tmux: null }), settings: settings(null), step: "node", override: null })).toBe(
      "tmux",
    );
    expect(clientScreen({ settings: settings(null), step: "node", override: null })).toBe("tmux");
    expect(clientScreen({ probe: probe(), settings: settings(null), step: "node", override: null })).toBe("register");
  });

  it("lands a configured client on Control Plane, whatever the machine is doing", () => {
    // The rule this module exists for: a configured client never auto-opens
    // the dashboard and never resumes a setup walk. The LANDING is Control
    // Plane (operator ruling 2026-09-22, second addendum — the section is
    // also the landing; previously Status): the screen that says which plane
    // this person came back to. Opening the plane's UI is still a press on
    // the Dashboard card, never automatic.
    for (const step of ["online", "stopped", "offline", "no-service", "not-enrolled", "no-node"] as const) {
      expect(
        clientScreen({ probe: probe({ step }), settings: settings("https://plane.test"), step: null, override: null }),
      ).toBe("plane");
    }
  });

  it("lands a configured client on Control Plane even for a step this build predates", () => {
    expect(
      clientScreen({
        probe: probe({ step: "what-even" as ProbeStep }),
        settings: settings("https://plane.test"),
        step: null,
        override: null,
      }),
    ).toBe("plane");
  });

  it("resumes a half-built node on Register rather than re-asking what it came to do", () => {
    // Spec § 5.5: the chain installed the agent and stopped before enrolling.
    // An agent fact has moved, so this is not a first run any more, and the
    // probe routes it — `not-enrolled` lands on Register, whose chain re-runs
    // the install as a no-op.
    expect(
      clientScreen({ probe: probe({ step: "not-enrolled" }), settings: settings(null), step: null, override: null }),
    ).toBe("register");
  });

  it("asks how the node will run before the chain that acts on the answer", () => {
    // The order is load-bearing, not cosmetic: the chain's last act is
    // `service install`, which the start-at-login answer parameterizes, so
    // `startup` precedes `registering` and the checklist never has to go back
    // and ask. (The sibling app puts the same question in the same place.)
    expect(clientScreen({ probe: probe(), settings: settings(null), step: "startup", override: null })).toBe("startup");
    expect(clientScreen({ probe: probe(), settings: settings(null), step: "registering", override: null })).toBe(
      "progress",
    );
  });

  it("holds the checklist while the chain runs, though enroll settles a plane mid-flight", () => {
    // `registering` is the case the walk-outranks-configured rule exists for:
    // enroll makes this client configured between two rows of the checklist,
    // and Status arriving there would replace the progress mid-press.
    expect(
      clientScreen({
        probe: enrolled("no-service"),
        settings: settings("https://p"),
        step: "registering",
        override: null,
      }),
    ).toBe("progress");
  });

  it("answers a walk phase this build predates with the screen that touches nothing", () => {
    expect(
      clientScreen({ probe: probe(), settings: settings(null), step: "what-even" as FteStep, override: null }),
    ).toBe("welcome");
  });

  it("keeps the person in the walk they are mid-way through, even once a plane is settled", () => {
    // Enrolling settles `planeUrl` while the chain is still starting the
    // service. A configured-outranks-everything rule would replace the
    // progress the person is watching with Status mid-press; the walk ends
    // when the page clears the step, not when a side effect lands.
    expect(
      clientScreen({ probe: enrolled("no-service"), settings: settings("https://p"), step: "node", override: null }),
    ).toBe("register");
    expect(clientScreen({ probe: probe(), settings: settings("https://p"), step: "watch", override: null })).toBe(
      "connect",
    );
  });

  it("gives a screen the user asked for precedence over everything but the first read", () => {
    const s = settings("https://plane.test");
    expect(clientScreen({ probe: probe(), settings: s, step: null, override: "reset" })).toBe("reset");
    expect(clientScreen({ probe: probe(), settings: s, step: "node", override: "about" })).toBe("about");
    expect(clientScreen({ probe: probe(), settings: settings(null), step: "choice", override: "update" })).toBe(
      "update",
    );
    // …but not over "nothing has been read yet": there is no screen to show.
    expect(clientScreen({ step: null, override: "about" })).toBeNull();
  });
});

describe("registerSteps", () => {
  const states = (phase: RegisterPhase, p: Probe | undefined = probe(), failed?: "install" | "enroll" | "start") =>
    registerSteps(p, phase, failed ?? null).map((r) => r.state);

  it("names each act the chain performs", () => {
    expect(registerSteps(probe(), "form").map((r) => [r.id, r.label])).toEqual([
      ["install", "Install the Subshell Node CLI"],
      ["enroll", "Enroll this machine"],
      ["start", "Start the node service"],
    ]);
  });

  it("marks the running act active and its predecessors done", () => {
    expect(states("installing")).toEqual(["active", "pending", "pending"]);
    expect(states("enrolling", probe({ step: "not-enrolled" }))).toEqual(["done", "active", "pending"]);
    expect(states("starting", probe({ step: "not-enrolled" }))).toEqual(["done", "done", "active"]);
    expect(states("done", enrolled("online"))).toEqual(["done", "done", "done"]);
  });

  it("reads the probe for what is already true, so a skipped act is not a lie", () => {
    // Nothing has run yet. The chain installs the agent only when the probe
    // says `no-node`, so a machine that already has one shows that row done
    // rather than promising an act that will be skipped.
    expect(states("form")).toEqual(["pending", "pending", "pending"]);
    expect(states("form", probe({ step: "not-enrolled" }))).toEqual(["done", "pending", "pending"]);
    expect(states("form", enrolled("stopped"))).toEqual(["done", "done", "pending"]);
    expect(states("form", enrolled("online"))).toEqual(["done", "done", "done"]);
  });

  it("lets the act in flight outrank the probe, so nothing reads done while it is running", () => {
    expect(states("installing", probe({ step: "not-enrolled" }))).toEqual(["active", "pending", "pending"]);
  });

  it("marks the act that failed and leaves what never ran pending", () => {
    expect(states("enrolling", probe({ step: "not-enrolled" }), "enroll")).toEqual(["done", "failed", "pending"]);
    expect(states("installing", probe(), "install")).toEqual(["failed", "pending", "pending"]);
    expect(states("starting", enrolled("no-service"), "start")).toEqual(["done", "done", "failed"]);
  });

  it("does not let the probe promote a row past the one that failed", () => {
    // A service that is somehow online while `enroll` failed is a machine in
    // a state this chain did not produce; the checklist says how far THIS
    // run got, which is what the person is reading it for.
    expect(states("enrolling", enrolled("online"), "enroll")).toEqual(["done", "failed", "pending"]);
  });

  it("answers for a phase this build predates without crashing", () => {
    expect(states("what-even" as RegisterPhase)).toEqual(["pending", "pending", "pending"]);
  });
});

/**
 * The rail's exclusion, as data (wave 3; the same rule the server's
 * `railFor` carries, operator ruling 2026-09-22: the FTE never gets it).
 * The screen is the discriminator — `clientScreen` has already folded the
 * walk, the overrides and the configured landing into one id — and the
 * second argument is the part the screen cannot see: the machine is SETTLED
 * (configured, no walk in progress), because the exclusion is about the
 * machine's journey, not about who asked.
 */
describe("railFor", () => {
  it("answers the six standing sections for a settled machine on a standing screen", () => {
    // Service and Control Plane joined by operator ruling 2026-09-22 (live
    // screenshots): the node's machinery and the plane address's home move
    // out of the status screen, and the rail carries them.
    for (const screen of ["status", "service", "plane", "update", "about"] as const) {
      const sections = railFor(screen, true);
      expect(
        sections?.map((s) => s.id),
        screen,
      ).toEqual(["plane", "status", "service", "update", "about", "reset"]);
      expect(
        sections?.map((s) => s.label),
        screen,
      ).toEqual(["Control Plane", "Status", "Service", "Update", "About", "Reset"]);
    }
    expect(railFor("status", true)?.find((s) => s.id === "reset")?.danger).toBe(true);
  });

  it("answers null for every FTE walk screen, enroll and the unread state", () => {
    // Reset LEFT this list (operator ruling 2026-09-22, final word on the
    // layout): its confirmation rides the rail, reset active; the
    // frame-replacing room is the RUNNING chain, which reset-screen.tsx
    // enforces off the runner's busy, not a railFor case.
    for (const screen of ["welcome", "choice", "tmux", "register", "startup", "progress", "connect"] as const) {
      expect(railFor(screen, true), screen).toBeNull();
    }
    expect(railFor(null, true)).toBeNull();
  });

  it("gives the reset confirmation the six sections, reset active", () => {
    const sections = railFor("reset", true);
    expect(sections?.map((s) => s.id)).toEqual(["plane", "status", "service", "update", "about", "reset"]);
    expect(sections?.find((s) => s.id === "reset")?.danger).toBe(true);
  });

  it("answers null for a standing screen on a machine mid-first-run", () => {
    // The tray can raise About mid-walk, and the router honours it; wave 2's
    // ruling keeps the render and takes away the rail — the exclusion is
    // about the machine's journey, not about who asked.
    for (const screen of ["status", "service", "plane", "update", "about"] as const) {
      expect(railFor(screen, false), screen).toBeNull();
    }
  });

  it("marks the active section by the screen, through railActive", () => {
    expect(railActive("status")).toBe("status");
    expect(railActive("service")).toBe("service");
    expect(railActive("plane")).toBe("plane");
    expect(railActive("update")).toBe("update");
    expect(railActive("about")).toBe("about");
    // Reset rides the rail now (operator ruling 2026-09-22): its
    // confirmation is a standing render, reset active.
    expect(railActive("reset")).toBe("reset");
    expect(railActive("welcome")).toBeNull();
    expect(railActive(null)).toBeNull();
  });
});
