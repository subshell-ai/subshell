import { describe, expect, it } from "bun:test";
import { ApiError } from "@internal/node-admin";
import { SSH_ERROR_DESCRIPTIONS, type SshConnectionSnapshotWire } from "@internal/subshell-protocol";
import { type SshConnectionView, sshDestinationLabel, sshErrorText, sshRouteLine } from "@/lib/ssh";
import {
  dropSshTerminalFacts,
  getSshTerminalFacts,
  patchSshTerminalFacts,
  putSshTerminalFacts,
  type SshTerminalFacts,
} from "@/lib/ssh-terminal-facts";

/**
 * The SSH lib half: the display grammar (destination line, route line, the
 * named-code error copy) and the tab facts store the pane chrome and the
 * upload gate read from. The store rules are the load-bearing ones: a patch
 * must not invent a row, a corrupt blob reads empty rather than throwing,
 * and an unknown pane must read as ORDINARY (null) - the honest default the
 * terminal page branches on.
 */

const SNAP: SshConnectionSnapshotWire = {
  alias: "staging",
  host: "app-02.example.net",
  user: "deploy",
  port: 2222,
  identityFiles: [],
  certificateFiles: [],
  authAgentSocket: null,
  knownHostsFiles: [],
  hostKeyAlias: null,
  proxyJumps: [],
  proxyCommand: null,
  forwards: null,
  tunnels: null,
  localCommands: null,
  remoteCommand: null,
  sendEnv: null,
  setEnv: null,
  escapes: null,
};

const conn = (over: Partial<SshConnectionView> = {}): SshConnectionView => ({
  id: "c1",
  nodeId: "n1",
  displayName: "Staging",
  snapshot: SNAP,
  remoteDir: null,
  revision: 2,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-02T10:00:00.000Z",
  ...over,
});

const facts = (over: Partial<SshTerminalFacts> = {}): SshTerminalFacts => ({
  subshellId: "p-1",
  connectionId: "c1",
  displayName: "Staging",
  destination: "deploy@app-02.example.net:2222",
  nodeId: "n1",
  nodeLabel: "Laptop",
  controlOwner: "human",
  controlGeneration: 1,
  ...over,
});

describe("ssh display grammar", () => {
  it("renders the destination bare at 22 and explicit otherwise", () => {
    expect(sshDestinationLabel({ ...SNAP, port: 22 })).toBe("deploy@app-02.example.net");
    expect(sshDestinationLabel(SNAP)).toBe("deploy@app-02.example.net:2222");
  });

  it("names the route line with node or an honest placeholder", () => {
    expect(sshRouteLine(conn(), "Laptop")).toBe("Staging · deploy@app-02.example.net:2222 · via Laptop");
    expect(sshRouteLine(conn(), null)).toContain("via an unknown node");
  });

  it("maps a named ssh refusal by equality to its shipped sentence", () => {
    const apiErr = new ApiError(409, "quota", { code: "quota_terminals" });
    expect(sshErrorText(apiErr)).toBe(SSH_ERROR_DESCRIPTIONS.quota_terminals);
    // A same-named code on a NON-ApiError earns no sentence (the guard is the
    // class, not the string); that error falls through to its own message.
    const lookalike = Object.assign(new Error("API 409: refused"), { code: "quota_terminals", status: 409 });
    expect(sshErrorText(lookalike, "fallback")).toBe("API 409: refused");
    expect(sshErrorText(new Error("boom"), "fallback")).toBe("boom");
    expect(sshErrorText("bare string", "fallback")).toBe("fallback");
  });
});

describe("ssh terminal facts store", () => {
  it("put → get round-trips, unknown ids read null", () => {
    expect(getSshTerminalFacts("p-1")).toBeNull();
    putSshTerminalFacts(facts());
    expect(getSshTerminalFacts("p-1")?.destination).toBe("deploy@app-02.example.net:2222");
    expect(getSshTerminalFacts("other")).toBeNull();
    dropSshTerminalFacts("p-1");
    expect(getSshTerminalFacts("p-1")).toBeNull();
  });

  it("patches a remembered row but never invents one", () => {
    putSshTerminalFacts(facts({ subshellId: "p-2", controlOwner: "human" }));
    patchSshTerminalFacts("p-2", { controlOwner: "agent", controlGeneration: 4 });
    expect(getSshTerminalFacts("p-2")?.controlOwner).toBe("agent");
    expect(getSshTerminalFacts("p-2")?.controlGeneration).toBe(4);
    // The display material survives the patch untouched.
    expect(getSshTerminalFacts("p-2")?.destination).toBe("deploy@app-02.example.net:2222");
    patchSshTerminalFacts("p-none", { controlOwner: "agent" });
    expect(getSshTerminalFacts("p-none")).toBeNull();
    dropSshTerminalFacts("p-2");
  });

  it("reads a corrupt blob as empty rather than throwing", () => {
    window.sessionStorage.setItem("subshell.sshTerminalFacts", "{not json");
    expect(getSshTerminalFacts("p-1")).toBeNull();
    putSshTerminalFacts(facts({ subshellId: "p-3" }));
    expect(getSshTerminalFacts("p-3")).toBeDefined();
    dropSshTerminalFacts("p-3");
  });
});
