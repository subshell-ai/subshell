import { describe, expect, it } from "bun:test";
import { isDocsUrl, PLUGIN_API_VERSION, parseManifest } from "../manifest.js";

/** A package.json that a valid plugin would ship. */
function pkg(over: Record<string, unknown> = {}): unknown {
  return {
    name: "@subshell-ai/plugin-claude-code",
    version: "1.0.0",
    subshell: {
      apiVersion: PLUGIN_API_VERSION,
      id: "claude-code",
      type: "agent-harness",
      name: "Claude Code",
      description: "Anthropic's agentic coding assistant",
      entry: "dist/index.js",
      detect: { binaryName: "claude", envOverride: "CLAUDE_PATH", knownPaths: [".local/bin/claude"] },
      install: { command: "npm i -g @anthropic-ai/claude-code", docsUrl: "https://example.invalid" },
      ...over,
    },
  };
}

describe("parseManifest", () => {
  it("accepts a well-formed manifest", () => {
    const result = parseManifest(pkg());
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.id).toBe("claude-code");
    expect(result.type).toBe("agent-harness");
    expect(result.detect?.binaryName).toBe("claude");
  });

  it("rejects a package.json with no subshell key", () => {
    expect("error" in parseManifest({ name: "x", version: "1.0.0" })).toBe(true);
  });

  it("rejects something that is not an object at all", () => {
    expect("error" in parseManifest(null)).toBe(true);
    expect("error" in parseManifest("nope")).toBe(true);
  });

  it("rejects an apiVersion this host cannot serve, naming both numbers", () => {
    const result = parseManifest(pkg({ apiVersion: PLUGIN_API_VERSION + 1 }));
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    // The reader has to decide whether to upgrade the plugin or the agent, and
    // one number cannot tell them that.
    expect(result.error).toContain(String(PLUGIN_API_VERSION));
    expect(result.error).toContain(String(PLUGIN_API_VERSION + 1));
  });

  it("accepts every version from 1 up to this host's, which is the point of the field", () => {
    // A host at version N keeps serving plugins built against 1..N. Written as
    // a range rather than `PLUGIN_API_VERSION - 1`, which is 0 today and is
    // now correctly refused as a version that never existed.
    for (let v = 1; v <= PLUGIN_API_VERSION; v++) {
      expect([v, "error" in parseManifest(pkg({ apiVersion: v }))]).toEqual([v, false]);
    }
  });

  it("refuses a version below 1", () => {
    for (const apiVersion of [0, -1]) {
      const result = parseManifest(pkg({ apiVersion }));
      expect("error" in result).toBe(true);
      if (!("error" in result)) continue;
      expect(result.error).toContain("not a version");
    }
  });

  it("rejects an unknown plugin type rather than guessing", () => {
    expect("error" in parseManifest(pkg({ type: "wat" }))).toBe(true);
  });

  it("accepts every type it claims to support", () => {
    for (const type of ["agent-harness", "terminal"]) {
      expect("error" in parseManifest(pkg({ type }))).toBe(false);
    }
  });

  it("rejects an id that is not a safe path segment", () => {
    // The id becomes a directory name under <dataDir>/plugins/.
    for (const id of ["../escape", "has space", "UPPER", "", "-leading", "a".repeat(65)]) {
      expect("error" in parseManifest(pkg({ id }))).toBe(true);
    }
  });

  it("rejects an entry that escapes the package directory", () => {
    for (const entry of ["../../etc/passwd", "/absolute/index.js", "", "nested/../../out.js"]) {
      expect("error" in parseManifest(pkg({ entry }))).toBe(true);
    }
  });

  it("accepts a nested entry that stays inside", () => {
    expect("error" in parseManifest(pkg({ entry: "dist/esm/index.js" }))).toBe(false);
  });

  it("accepts a manifest with no detect block, for a plugin that needs no binary", () => {
    const bare = pkg() as { subshell: Record<string, unknown> };
    delete bare.subshell.detect;
    const result = parseManifest(bare);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.detect).toBeUndefined();
  });

  it("rejects a half-written detect block", () => {
    expect("error" in parseManifest(pkg({ detect: { binaryName: "claude" } }))).toBe(true);
    expect("error" in parseManifest(pkg({ detect: { binaryName: "c", envOverride: "C", knownPaths: [1] } }))).toBe(
      true,
    );
  });

  it("carries the hostEnv declaration through, and its absence stays absence", () => {
    const result = parseManifest(pkg({ hostEnv: ["CLAUDE_CONFIG_DIR"] }));
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.hostEnv).toEqual(["CLAUDE_CONFIG_DIR"]);
    // Absent is not `[]`: the field means "these names drive what the node
    // reports"; a plugin that declared nothing never sends the key.
    const bare = parseManifest(pkg());
    expect("error" in bare ? null : bare.hostEnv).toBeUndefined();
  });

  it("rejects a hostEnv that is not a list of variable names", () => {
    expect("error" in parseManifest(pkg({ hostEnv: "CLAUDE_CONFIG_DIR" }))).toBe(true);
    expect("error" in parseManifest(pkg({ hostEnv: [1] }))).toBe(true);
    expect("error" in parseManifest(pkg({ hostEnv: [""] }))).toBe(true);
    expect("error" in parseManifest(pkg({ hostEnv: ["  "] }))).toBe(true);
  });

  it("carries the optional icon and install block through", () => {
    const result = parseManifest(pkg({ icon: "icon.svg" }));
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.icon).toBe("icon.svg");
    expect(result.install?.docsUrl).toBe("https://example.invalid");
  });

  it("refuses an icon that is not a path to a file the package ships", () => {
    // `icon` names a FILE now, not a glyph. An emoji parsed fine under the
    // old contract and would now be joined onto the plugin directory and
    // read, so it has to fail here rather than 404 at the route.
    expect("error" in parseManifest(pkg({ icon: "🤖" }))).toBe(true);
    expect("error" in parseManifest(pkg({ icon: "" }))).toBe(true);
    expect("error" in parseManifest(pkg({ icon: 7 }))).toBe(true);
  });

  it("refuses an icon that escapes the package, exactly as `entry` is refused", () => {
    expect("error" in parseManifest(pkg({ icon: "/etc/passwd.png" }))).toBe(true);
    expect("error" in parseManifest(pkg({ icon: "../../secrets.svg" }))).toBe(true);
    // A `..` has to be a SEGMENT to be traversal; a file merely named with
    // dots is fine.
    expect("error" in parseManifest(pkg({ icon: "art/..logo.svg" }))).toBe(false);
  });

  it("refuses an extension the server has no Content-Type for", () => {
    // The type is mapped from the NAME, never sniffed from a third party's
    // bytes, so an extension outside the table has no safe answer.
    expect("error" in parseManifest(pkg({ icon: "icon.gif" }))).toBe(true);
    expect("error" in parseManifest(pkg({ icon: "icon.html" }))).toBe(true);
    for (const ok of ["icon.svg", "icon.png", "icon.webp", "art/mark.png"]) {
      expect("error" in parseManifest(pkg({ icon: ok }))).toBe(false);
    }
  });
});

/** What a `type: "network"` plugin's package.json carries. */
function networkPkg(over: Record<string, unknown> = {}): unknown {
  return {
    name: "@subshell-ai/plugin-tailscale",
    version: "1.0.0",
    subshell: {
      apiVersion: PLUGIN_API_VERSION,
      id: "tailscale",
      type: "network",
      name: "Tailscale",
      description: "Reach this server over your tailnet",
      entry: "dist/index.js",
      detect: { binaryName: "tailscale", envOverride: "TAILSCALE_PATH", knownPaths: [] },
      network: {
        platforms: ["darwin", "linux"],
        exposure: "private",
        interactiveLogin: true,
        privileged: {
          linux: [{ label: "Install the daemon", command: "curl -fsSL https://tailscale.com/install.sh | sh" }],
        },
      },
      ...over,
    },
  };
}

describe("parseManifest (network)", () => {
  it("accepts a well-formed network manifest", () => {
    const result = parseManifest(networkPkg());
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.type).toBe("network");
    expect(result.network?.platforms).toEqual(["darwin", "linux"]);
    expect(result.network?.exposure).toBe("private");
    expect(result.network?.interactiveLogin).toBe(true);
    expect(result.network?.privileged?.linux?.[0]?.label).toBe("Install the daemon");
  });

  it("requires the network block on a network plugin", () => {
    // Nothing could render the row without it: not which platforms it runs on,
    // and not what publishing exposes — which has no safe default to guess.
    const result = parseManifest(networkPkg({ network: undefined }));
    expect("error" in result && result.error).toContain("`subshell.network` is required");
  });

  it("refuses a network block on a harness", () => {
    const result = parseManifest(pkg({ network: { platforms: ["linux"], exposure: "private" } }));
    expect("error" in result && result.error).toContain('only for `type: "network"`');
  });

  it("refuses an empty or unknown platform list", () => {
    expect("error" in parseManifest(networkPkg({ network: { platforms: [], exposure: "private" } }))).toBe(true);
    const bad = parseManifest(networkPkg({ network: { platforms: ["win32"], exposure: "private" } }));
    expect("error" in bad && bad.error).toContain("platforms");
  });

  it("refuses an exposure it does not know", () => {
    const result = parseManifest(networkPkg({ network: { platforms: ["linux"], exposure: "public" } }));
    expect("error" in result && result.error).toContain("exposure");
  });

  it("carries publishImplicit when declared, and only then", () => {
    // The flag exists so the HOST can tell "joined but not yet published"
    // from "publishing, by a join the daemon cannot later be asked about"
    // (NetBird). A plugin without it is never upgraded, so its absence on
    // an ordinary manifest matters as much as its presence on that one.
    const plain = parseManifest(networkPkg());
    expect("error" in plain).toBe(false);
    if ("error" in plain) return;
    expect(plain.network?.publishImplicit).toBeUndefined();

    const flagged = parseManifest(
      networkPkg({ network: { platforms: ["darwin", "linux"], exposure: "private", publishImplicit: true } }),
    );
    expect("error" in flagged).toBe(false);
    if ("error" in flagged) return;
    expect(flagged.network?.publishImplicit).toBe(true);

    // `false` is accepted (it is a boolean) and normalised to absent —
    // there is one shape downstream to read, not two.
    const saidNo = parseManifest(
      networkPkg({ network: { platforms: ["darwin", "linux"], exposure: "private", publishImplicit: false } }),
    );
    expect("error" in saidNo).toBe(false);
    if ("error" in saidNo) return;
    expect(saidNo.network?.publishImplicit).toBeUndefined();
  });

  it("refuses a publishImplicit that is not a boolean", () => {
    const result = parseManifest(
      networkPkg({ network: { platforms: ["linux"], exposure: "private", publishImplicit: "yes" } }),
    );
    expect("error" in result && result.error).toContain("publishImplicit");
  });

  it("refuses a privileged block keyed by an unknown platform", () => {
    const result = parseManifest(
      networkPkg({
        network: { platforms: ["linux"], exposure: "private", privileged: { win32: [{ label: "x", command: "y" }] } },
      }),
    );
    expect("error" in result && result.error).toContain("unknown platform");
  });

  it("refuses a sudo install command", () => {
    // The host RUNS install.command on request and has no terminal for a
    // password prompt, so a privileged installer belongs in `privileged`
    // where it is only ever printed.
    const result = parseManifest(
      networkPkg({ install: { command: "sudo apt install tailscale", docsUrl: "https://x.invalid" } }),
    );
    expect("error" in result && result.error).toContain("must not need sudo");
  });

  it("allows an unprivileged install command", () => {
    const result = parseManifest(
      networkPkg({ install: { command: "brew install cloudflared", docsUrl: "https://x.invalid" } }),
    );
    expect("error" in result).toBe(false);
  });

  it("refuses an install docsUrl a browser must not navigate to", () => {
    // Every docsUrl in this manifest becomes the href of an anchor on an admin
    // page, and `javascript:` in an href is script on the control plane's
    // origin in the session of the one person who can install plugins.
    const result = parseManifest(
      networkPkg({ install: { command: "brew install cloudflared", docsUrl: "javascript:alert(1)" } }),
    );
    expect("error" in result && result.error).toContain("http(s)");
  });

  it("round-trips a privileged step's group, which makes the steps ALTERNATIVES", () => {
    // Two ways onto the same network — the Tailscale app or the command-line
    // daemon — are not one sequence, and a page that numbered them 1..3 told
    // a person to do both. The group is what says "or".
    const result = parseManifest(
      networkPkg({
        network: {
          platforms: ["darwin"],
          exposure: "private",
          privileged: {
            darwin: [
              { label: "Install the app", command: "brew install --cask tailscale-app", group: "The app" },
              { label: "Install the daemon", command: "brew install --formula tailscale", group: "The daemon" },
            ],
          },
        },
      }),
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.network?.privileged?.darwin?.map((s) => s.group)).toEqual(["The app", "The daemon"]);
  });

  it("refuses an empty group, naming the field and the step", () => {
    // A group is rendered as a heading above its steps, so `""` is a heading
    // with no words — refused rather than coerced, exactly as an empty label
    // is.
    const result = parseManifest(
      networkPkg({
        network: {
          platforms: ["linux"],
          exposure: "private",
          privileged: { linux: [{ label: "Install the daemon", command: "sudo apt install x", group: "" }] },
        },
      }),
    );
    expect("error" in result && result.error).toContain("group");
    expect("error" in result && result.error).toContain("Install the daemon");
  });

  it("refuses a privileged step's docsUrl on the same rule, and names the step", () => {
    const result = parseManifest(
      networkPkg({
        network: {
          platforms: ["linux"],
          exposure: "private",
          privileged: {
            linux: [{ label: "Install the daemon", command: "sudo apt install x", docsUrl: "javascript:alert(1)" }],
          },
        },
      }),
    );
    expect("error" in result && result.error).toContain("http(s)");
    expect("error" in result && result.error).toContain("Install the daemon");
  });
});

describe("isDocsUrl", () => {
  it("accepts the two schemes a browser navigates to", () => {
    expect(isDocsUrl("https://tailscale.com/kb/1080/cli")).toBe(true);
    expect(isDocsUrl("http://headscale.internal/docs")).toBe(true);
  });

  it("refuses every scheme that is not one of those", () => {
    // The first is the one that executes; the rest are here so a later edit
    // that reaches for a scheme allowlist finds the shape already decided.
    expect(isDocsUrl("javascript:alert(document.cookie)")).toBe(false);
    expect(isDocsUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isDocsUrl("file:///etc/passwd")).toBe(false);
    expect(isDocsUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("refuses the obfuscations that get past a naive prefix check", () => {
    // A leading control character, interleaved whitespace and mixed case all
    // survive a `startsWith("javascript:")` test and all still execute in a
    // browser. The URL parser normalizes them, which is why parsing beats
    // matching here.
    expect(isDocsUrl("\u0000javascript:alert(1)")).toBe(false);
    expect(isDocsUrl("  javascript:alert(1)")).toBe(false);
    expect(isDocsUrl("java\tscript:alert(1)")).toBe(false);
    expect(isDocsUrl("JaVaScRiPt:alert(1)")).toBe(false);
  });

  it("refuses anything that is not an absolute URL at all", () => {
    // A relative href resolves against the SPA's own origin, which is never
    // what a vendor documentation link means.
    expect(isDocsUrl("/settings/networking")).toBe(false);
    expect(isDocsUrl("tailscale.com/kb")).toBe(false);
    expect(isDocsUrl("")).toBe(false);
  });
});

describe("parseManifest (network labels)", () => {
  it("accepts the vendor's own words for the two acts", () => {
    const result = parseManifest(
      networkPkg({
        network: {
          platforms: ["linux"],
          exposure: "private",
          labels: { credential: "Setup key", publish: "Start tunnel" },
        },
      }),
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.network?.labels).toEqual({ credential: "Setup key", publish: "Start tunnel" });
  });

  it("refuses an empty label rather than coercing it", () => {
    // An empty string renders as a control with no name, which is worse than
    // the generic default it was meant to replace.
    const result = parseManifest(
      networkPkg({ network: { platforms: ["linux"], exposure: "private", labels: { credential: "  " } } }),
    );
    expect("error" in result && result.error).toContain("non-empty");
  });

  it("leaves labels absent when the plugin says nothing", () => {
    const result = parseManifest(networkPkg());
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.network?.labels).toBeUndefined();
  });
});
