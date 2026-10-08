import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSshConfigPath, renderSshConfigContents, sshDestinationToken, sshOptionTokens } from "../ssh-render.js";
import { makeSnapshot } from "./helpers.js";

/**
 * The renderer is where the M1 every-hop policy becomes bytes (spec
 * 2026-10-07 §5.2/§9). The tests below are the policy's regression net: every
 * retained confinement clause ("host-key trust with accept-new, no agent/X11
 * forwarding, no forwards, no local commands, no escapes, no multiplexing, no
 * imported RemoteCommand/SendEnv/SetEnv") must appear in the rendered
 * artifact, the option argv must carry ONLY destination-scoped facts, and the
 * interactive posture must show: no BatchMode, no refused auth methods, no
 * /dev/null trust stand-in.
 */

/** The base snapshot: a grammatically valid approved snapshot; override any field. */
const baseSnapshot = makeSnapshot;

describe("renderSshConfigContents", () => {
  const config = renderSshConfigContents(baseSnapshot());

  it("Host * carries the interactive-terminal policy, not BatchMode", () => {
    const out = renderSshConfigContents(baseSnapshot());
    expect(out).toContain("    StrictHostKeyChecking accept-new");
    expect(out).not.toContain("BatchMode");
    expect(out).not.toContain("PasswordAuthentication no");
    expect(out).not.toContain("UserKnownHostsFile /dev/null"); // default known_hosts is the M1 authority (spec §9)
    expect(out).toContain("    ForwardAgent no");
    expect(out).toContain("    ControlPath none");
    expect(out).toContain("    EscapeChar none");
    expect(out).toContain("    RemoteCommand none");
    expect(out).toContain("    CanonicalizeHostname no");
  });

  it("carries the retained every-hop policy under Host * (which the jump children read too)", () => {
    expect(config).toContain("Host *");
    const required: [string, string][] = [
      ["StrictHostKeyChecking", "accept-new"],
      ["ForwardAgent", "no"],
      ["ForwardX11", "no"],
      ["ForwardX11Trusted", "no"],
      ["ClearAllForwardings", "yes"],
      ["Tunnel", "no"],
      ["PermitRemoteOpen", "none"],
      ["PermitLocalCommand", "no"],
      ["RemoteCommand", "none"],
      ["EscapeChar", "none"],
      ["ControlMaster", "no"],
      ["ControlPath", "none"],
      ["GSSAPIAuthentication", "no"],
      ["VerifyHostKeyDNS", "no"],
      ["CanonicalizeHostname", "no"],
    ];
    for (const [key, value] of required) {
      expect(config).toContain(`    ${key} ${value}`);
    }
    // The interactive session offers every auth method the SERVER offers: the
    // tier's refusals must not come back (BatchMode's comment says why).
    expect(config).not.toContain("KbdInteractiveAuthentication no");
    expect(config).not.toContain("HostbasedAuthentication no");
    // The removed Kerberos* alias must never come back: recent OpenSSH no
    // longer resolves it (10.2p1 warns on every launch and continues), and
    // GSSAPIAuthentication above is the spelling that actually disables that
    // auth path.
    expect(config).not.toContain("KerberosAuthentication");
  });

  it("known-hosts refs render when the snapshot names them", () => {
    const out = renderSshConfigContents(baseSnapshot({ knownHostsFiles: ["/home/theo/.ssh/known_hosts"] }));
    expect(out).toContain("    UserKnownHostsFile /home/theo/.ssh/known_hosts");
  });

  it("renders no UserKnownHostsFile at all when the snapshot names none (silence IS the policy, §9)", () => {
    const out = renderSshConfigContents(baseSnapshot({ knownHostsFiles: [] }));
    expect(out).not.toContain("UserKnownHostsFile");
  });

  it("renders identity/certificate refs under Host * so EVERY hop authenticates from approved material", () => {
    const rendered = renderSshConfigContents(
      baseSnapshot({ identityFiles: ["/home/deploy/.ssh/id_ed25519"], certificateFiles: ["/home/deploy/.ssh/id.pub"] }),
    );
    expect(rendered).toContain("    IdentityFile /home/deploy/.ssh/id_ed25519");
    expect(rendered).toContain("    CertificateFile /home/deploy/.ssh/id.pub");
  });

  it("identity/cert refs render quoted only when they need quoting", () => {
    const rendered = renderSshConfigContents(
      baseSnapshot({
        identityFiles: ["/home/deploy/my keys/id_ed25519"],
        certificateFiles: ['/opt/we"ird/cert.pub'],
        knownHostsFiles: ["/home/deploy/my hosts/known_hosts", "/plain/path"],
      }),
    );
    // OpenSSH's config tokenizer splits values on whitespace and honors
    // double quotes with backslash escapes — that IS the quoting accepted.
    expect(rendered).toContain('    IdentityFile "/home/deploy/my keys/id_ed25519"');
    expect(rendered).toContain('    CertificateFile "/opt/we\\"ird/cert.pub"');
    expect(rendered).toContain('    UserKnownHostsFile "/home/deploy/my hosts/known_hosts"');
    expect(rendered).toContain("    UserKnownHostsFile /plain/path"); // no churn for bytes that need none
  });

  it("ships its header with no em dash (the voice rule covers generated strings)", () => {
    expect(config).toContain("# Subshell managed SSH config - GENERATED, do not edit.");
    expect(config).not.toContain("—");
  });

  it("never renders ProxyCommand or any forbidden concept", () => {
    for (const word of ["ProxyCommand", "LocalForward", "RemoteForward", "DynamicForward", "SendEnv", "SetEnv"]) {
      // The ONLY occurrence of the policy line words is the refusal line we DO render
      // (RemoteCommand none etc.); a command VALUE must never appear.
      const occurrences = config.split(word).length - 1;
      if (word === "RemoteCommand") {
        expect(occurrences).toBe(1); // the `RemoteCommand none` policy line itself
      } else {
        expect(occurrences).toBe(0);
      }
    }
    expect(config).toContain("RemoteCommand none");
  });

  it("refuses to render a hand-built snapshot carrying a forbidden member", () => {
    const smuggled = { ...baseSnapshot(), proxyCommand: "nc attacker 4444" } as unknown as ReturnType<
      typeof baseSnapshot
    >;
    expect(() => renderSshConfigContents(smuggled)).toThrow("not renderable");
  });
});

describe("sshOptionTokens", () => {
  it("sshOptionTokens is destination-scoped only", () => {
    const tokens = sshOptionTokens(
      baseSnapshot({ port: 2222, user: "root", proxyJumps: [{ host: "j1", user: null, port: 22 }] }),
      "/data/ssh/s1/config",
    );
    expect(tokens).toEqual(["-F", "/data/ssh/s1/config", "-p", "2222", "-l", "root", "-o", "ProxyJump=j1"]);
  });

  it("points -F at the rendered file and passes ONLY destination-scoped options", () => {
    const tokens = sshOptionTokens(
      baseSnapshot({ hostKeyAlias: "app02-web", port: 2222 }),
      "/var/lib/subshell/ssh/runs/r1/config",
    );
    expect(tokens.slice(0, 2)).toEqual(["-F", "/var/lib/subshell/ssh/runs/r1/config"]);
    expect(tokens).toContain("-p");
    expect(tokens[tokens.indexOf("-p") + 1]).toBe("2222");
    expect(tokens).toContain("-l");
    expect(tokens[tokens.indexOf("-l") + 1]).toBe("deploy");
    expect(tokens).toContain("HostKeyAlias=app02-web");
    // policy options are NOT command-line options: they live in the -F file
    // (the jump children read the file, never the parent's argv).
    expect(tokens.every((a) => !a.startsWith("StrictHostKeyChecking") && !a.startsWith("ForwardAgent"))).toBe(true);
    // the pane's PTY comes from tmux, so ssh auto-requests a remote tty: no -tt rides.
    expect(tokens).not.toContain("-tt");
    // the `--` terminator and the host are NOT option tokens (sshDestinationToken carries the tail).
    expect(tokens).not.toContain("--");
    expect(tokens).not.toContain("app-02.example.com");
  });

  it("omits -l when the snapshot names no user, and HostKeyAlias when it names none", () => {
    const tokens = sshOptionTokens(baseSnapshot({ user: null, hostKeyAlias: null }), "/x/config");
    expect(tokens).not.toContain("-l");
    expect(tokens.every((a) => !a.startsWith("HostKeyAlias="))).toBe(true);
    expect(tokens[0]).toBe("-F");
    expect(tokens[2]).toBe("-p"); // -p is ALWAYS explicit: the port is a resolved fact, never ssh's guess
  });

  it("normalizes the whole ProxyJump chain into the approved hop list", () => {
    const tokens = sshOptionTokens(
      baseSnapshot({
        proxyJumps: [
          { host: "jump.example.com", user: "ops", port: 22 },
          { host: "[2001:db8::1]", user: null, port: 2222 },
        ],
      }),
      "/x/config",
    );
    expect(tokens[tokens.indexOf("ProxyJump=ops@jump.example.com,[2001:db8::1]:2222") - 1]).toBe("-o");
    expect(tokens).not.toContain("-W"); // the chain is ssh's mechanism, ours is the approved list
  });

  it("refuses an option-like or empty config path", () => {
    expect(() => sshOptionTokens(baseSnapshot(), "-o evil")).toThrow(/absolute/);
    expect(() => sshOptionTokens(baseSnapshot(), "")).toThrow(/absolute/);
  });

  it("refuses an unrenderable snapshot at the last station before argv", () => {
    expect(() =>
      sshOptionTokens({ ...baseSnapshot(), host: "-oProxyCommand=x" } as never, "/data/ssh/s1/config"),
    ).toThrow(/not renderable/);
    expect(() =>
      sshOptionTokens(
        { ...baseSnapshot(), proxyJumps: [{ host: "-jump", user: null, port: 22 }] } as never,
        "/data/ssh/s1/config",
      ),
    ).toThrow(/not renderable/);
  });
});

describe("sshDestinationToken", () => {
  it("is the bare host, undecorated (the `--` tail is one argv entry)", () => {
    expect(sshDestinationToken(baseSnapshot())).toBe("app-02.example.com");
    expect(sshDestinationToken(baseSnapshot({ host: "[2001:db8::1]", user: "root", port: 2222 }))).toBe(
      "[2001:db8::1]",
    );
  });

  it("refuses an unrenderable snapshot", () => {
    expect(() => sshDestinationToken({ ...baseSnapshot(), host: "-oProxyCommand=x" } as never)).toThrow(
      /not renderable/,
    );
  });
});

describe("buildSshConfigPath", () => {
  it("composes the derived path from the two facts each side already holds", () => {
    expect(buildSshConfigPath("/data", "s1")).toBe("/data/ssh/s1/config");
    expect(buildSshConfigPath("/var/lib/subshell", "00000000-0000-4000-8000-000000000001")).toBe(
      "/var/lib/subshell/ssh/00000000-0000-4000-8000-000000000001/config",
    );
  });

  it("throws on a relative or empty dataDir (impossible-state guard, never a composed path)", () => {
    expect(() => buildSshConfigPath("data", "s1")).toThrow(/absolute/);
    expect(() => buildSshConfigPath("", "s1")).toThrow(/absolute/);
  });

  it("throws on an id outside the grammar", () => {
    expect(() => buildSshConfigPath("/d", "")).toThrow(/subshellId/);
    expect(() => buildSshConfigPath("/d", "s 1")).toThrow(/subshellId/);
    expect(() => buildSshConfigPath("/d", "../escape")).toThrow(/subshellId/);
    expect(() => buildSshConfigPath("/d", "a".repeat(65))).toThrow(/subshellId/);
    expect(buildSshConfigPath("/d", "a".repeat(64))).toBe(`/d/ssh/${"a".repeat(64)}/config`);
  });
});

describe("Metro purity", () => {
  it("ssh-render.ts imports no node: builtin (the pane-runtime barrel rule)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "ssh-render.ts"), "utf8");
    expect(source).not.toMatch(/from\s+"node:/);
    expect(source).not.toMatch(/require\(\s*"node:/);
  });
});
