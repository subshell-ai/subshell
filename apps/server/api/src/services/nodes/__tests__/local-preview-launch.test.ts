import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { getHarness, PreviewDisplays, TmuxRunner, xauthorityPath } from "@internal/pane-runtime";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { LocalLauncher } from "@/services/nodes/local-launcher.js";
import type { LaunchPlan } from "@/services/nodes/node-launcher.js";

class Screens extends PreviewDisplays {
  opened: string[] = [];
  closed: string[] = [];
  failure: Error | null = null;
  constructor() {
    super(SUBSHELL_SERVER_DATA_DIR);
  }
  override async openFor(id: string) {
    this.opened.push(id);
    if (this.failure) throw this.failure;
    return { display: ":91", rfbPort: 5911 };
  }
  override closeFor(id: string) {
    this.closed.push(id);
  }
}
class Tmux extends TmuxRunner {
  command = "";
  fail = false;
  override newSubshell(_socket: string, _id: string, _cwd: string, cmd: string) {
    this.command = cmd;
    if (this.fail) throw new Error("spawn failed");
  }
  override pipePane() {}
  override killSubshell() {}
}
function plan(): LaunchPlan {
  const harness = getHarness("terminal");
  if (!harness) throw new Error("terminal missing");
  return {
    id: crypto.randomUUID(),
    socket: "test",
    harness,
    binary: "/bin/sh",
    cwd: tmpdir(),
    subshellName: "test",
    subshellEnv: {},
    preset: {
      name: "test",
      env: { DISPLAY: ":wrong", XAUTHORITY: "/wrong" },
      flags: [],
      settings: null,
      configIsolation: false,
    },
    screen: { width: 1280, height: 800 },
  };
}

describe("local screen launch", () => {
  it("passes the allocated display above preset env, and tears it down with the subshell", async () => {
    const tmux = new Tmux();
    const displays = new Screens();
    const input = plan();
    const launcher = new LocalLauncher({ tmux, displays });
    await launcher.launch(input);
    expect(displays.opened).toEqual([input.id]);
    expect(tmux.command).toContain("DISPLAY=':91'");
    expect(tmux.command).toContain(`XAUTHORITY='${xauthorityPath(SUBSHELL_SERVER_DATA_DIR, input.id)}'`);
    expect(tmux.command).not.toContain(":wrong");
    await launcher.killSubshell(input.socket, input.id);
    expect(displays.closed).toEqual([input.id]);
  });
  it("releases the allocated screen if tmux fails", async () => {
    const tmux = new Tmux();
    tmux.fail = true;
    const displays = new Screens();
    const input = plan();
    await expect(new LocalLauncher({ tmux, displays }).launch(input)).rejects.toThrow("spawn failed");
    expect(displays.closed).toEqual([input.id]);
  });
  it("names missing display dependencies before spawning a subshell", async () => {
    const tmux = new Tmux();
    const displays = new Screens();
    displays.failure = new Error("preview-display-missing-binaries: Xvfb");
    await expect(new LocalLauncher({ tmux, displays }).launch(plan())).rejects.toThrow("Install them on that machine");
    expect(tmux.command).toBe("");
  });
});
