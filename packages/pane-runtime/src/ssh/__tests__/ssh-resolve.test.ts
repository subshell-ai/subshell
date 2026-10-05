import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProxyHop, resolveSshAliasConfig } from "../ssh-resolve.js";
import { cleanup, tempRoot, writeSshShim } from "./helpers.js";

/**
 * Resolution tests run pane-runtime's resolver against a SHIM ssh that emits
 * canned `ssh -G` output — the shape of the answer is what the filter must
 * decide on, and the shim keeps the decision hermetic. (The real sshd suite
 * in `ssh-loopback-sshd.test.ts` covers the same paths against the actual
 * OpenSSH evaluator; here we test the filter, not OpenSSH.)
 *
 * The canned fixtures mirror the REAL grammar measured on OpenSSH 10.2p1
 * (review finding C1: the first fixtures omitted `-G`'s default
 * `tunnel false` / `permitremoteopen any` lines and the tilde-form default
 * identityfiles, so a filter bug hiding under those spellings was invisible
 * to every fixture). The suite ends with the pin the fixture mirror cannot
 * be trusted to be honest about: `resolveSshAliasConfig` driven by the REAL
 * host `ssh -G`, loud-skipped only where ssh is absent.
 *
 * The shim's `-F` handling is deliberately bypassed for the `-G` branch
 * except to confirm the resolver names the fixture config file: the canned
 * output IS the fake OpenSSH answer.
 */

let root: string;

beforeAll(() => {
  root = tempRoot("subshell-ssh-resolve-");
});

afterAll(() => cleanup(root));

function gConfig(body: string, _aliasLines = true): { homeDir: string; configPath: string } {
  const dir = tempRoot("subshell-ssh-resolve-cfg-");
  const configPath = join(dir, "config");
  writeFileSync(configPath, body);
  return { homeDir: dir, configPath };
}

/** Run the resolver with a shim whose -G output is `gOutput`; also hands back the fixture home (tilde-expansion asserts). */
async function resolveWith(
  alias: string,
  gOutput: string,
  opts: {
    configBody?: string;
    env?: Record<string, string | undefined>;
    account?: string;
  } = {},
): Promise<{ out: Awaited<ReturnType<typeof resolveSshAliasConfig>>; homeDir: string }> {
  const dir = tempRoot("subshell-ssh-resolve-run-");
  const shim = writeSshShim(join(dir, "bin"), { dashG: gOutput });
  const cfg = gConfig(opts.configBody ?? `Host ${alias}\n  HostName resolved.example\n`);
  const out = await resolveSshAliasConfig(alias, {
    sshBin: shim.bin,
    homeDir: cfg.homeDir,
    configPath: cfg.configPath,
    env: { PATH: "/usr/bin", HOME: cfg.homeDir, ...opts.env },
    connectingAccount: opts.account ?? "opsuser",
    timeoutMs: 5_000,
  });
  return { out, homeDir: cfg.homeDir };
}

/**
 * The filter's own clean answer, spelled like a real 10.x `-G`: the default
 * `tunnel false` / `permitremoteopen any` / `permitlocalcommand no` lines are
 * PRESENT (an unconfigured option is echoed with its default spelling, and
 * the filter must know that spelling — a fixture that omitted them let the
 * every-alias-refused bug through).
 */
const CLEAN_G = [
  "host resolved.example",
  "hostname resolved.example",
  "user deploy",
  "port 2222",
  "identityfile /home/ops/.ssh/id_ed25519",
  "certificatefile /home/ops/.ssh/id_ed25519-cert.pub",
  "userknownhostsfile /home/ops/.ssh/known_hosts",
  "hostkeyalias app02-web",
  "forwardagent no",
  "gssapiauthentication no",
  "tunnel false",
  "tunneldevice any:any",
  "permitremoteopen any",
  "permitlocalcommand no",
  "addkeystoagent false",
  "controlmaster false",
].join("\n");

/**
 * A plain-alias answer straight out of OpenSSH 10.x defaults: the identity
 * files arrive in `~/.ssh/...` TILDE FORM (the `-G` default spelling), the
 * known-hosts file is already absolute, and there is no explicit
 * IdentityAgent line. This is the dump that turned every alias without an
 * explicit IdentityFile into `config_ambiguous` before the tilde expanded.
 */
const REAL10X_G = [
  "host plainhost",
  "hostname plainhost",
  "user opsuser",
  "port 22",
  "addressfamily any",
  "batchmode no",
  "checkhostip no",
  "compression no",
  "controlmaster false",
  "forwardx11 no",
  "gssapiauthentication no",
  "hashknownhosts no",
  "identitiesonly no",
  "kbdinteractiveauthentication yes",
  "passwordauthentication yes",
  "permitlocalcommand no",
  "pubkeyauthentication true",
  "requesttty auto",
  "stricthostkeychecking ask",
  "tcpkeepalive yes",
  "tunnel false",
  "verifyhostkeydns false",
  "visualhostkey no",
  "canonicalizemaxdots 1",
  "connectionattempts 1",
  "serveralivecountmax 3",
  "serveraliveinterval 0",
  "requiredrsasize 1024",
  "ciphers chacha20-poly1305@openssh.com,aes128-gcm@openssh.com",
  "loglevel INFO",
  "identityfile ~/.ssh/id_rsa",
  "identityfile ~/.ssh/id_ecdsa",
  "identityfile ~/.ssh/id_ecdsa_sk",
  "identityfile ~/.ssh/id_ed25519",
  "identityfile ~/.ssh/id_ed25519_sk",
  "globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2",
  "userknownhostsfile /home/opsuser/.ssh/known_hosts /home/opsuser/.ssh/known_hosts2",
  "logverbose none",
  "channeltimeout none",
  "permitremoteopen any",
  "addkeystoagent false",
  "forwardagent no",
  "connecttimeout none",
  "tunneldevice any:any",
].join("\n");

describe("resolveSshAliasConfig", () => {
  it("normalizes a clean answer into the approved snapshot", async () => {
    const { out } = await resolveWith("app02", CLEAN_G);
    expect(out.accepted).toBe(true);
    if (out.accepted) {
      expect(out.snapshot.host).toBe("resolved.example");
      expect(out.snapshot.user).toBe("deploy");
      expect(out.snapshot.port).toBe(2222);
      expect(out.snapshot.identityFiles).toEqual(["/home/ops/.ssh/id_ed25519"]);
      expect(out.snapshot.certificateFiles).toEqual(["/home/ops/.ssh/id_ed25519-cert.pub"]);
      expect(out.snapshot.knownHostsFiles).toEqual(["/home/ops/.ssh/known_hosts"]);
      expect(out.snapshot.hostKeyAlias).toBe("app02-web");
      expect(out.snapshot.alias).toBe("app02");
      expect(out.connectingAccount).toBe("opsuser");
      // forbidden members exist as null, by grammar
      expect(out.snapshot.proxyCommand).toBeNull();
    }
  });

  it("accepts a whole-dump of real OpenSSH 10.x defaults, expanding tilde identity refs", async () => {
    const { out, homeDir } = await resolveWith("plainhost", REAL10X_G, {
      configBody: "Host something-else\n  HostName elsewhere\n",
    });
    expect(out.accepted).toBe(true);
    if (out.accepted) {
      // The tilde defaults expanded against the fixture home; nothing on the
      // snapshot may stay tilde-form (the parser refuses it, and refusing a
      // DEFAULT config is the C1 defect).
      expect(out.snapshot.identityFiles).toEqual([
        join(homeDir, ".ssh/id_rsa"),
        join(homeDir, ".ssh/id_ecdsa"),
        join(homeDir, ".ssh/id_ecdsa_sk"),
        join(homeDir, ".ssh/id_ed25519"),
        join(homeDir, ".ssh/id_ed25519_sk"),
      ]);
      expect(out.snapshot.identityFiles.every((p) => p.startsWith("/"))).toBe(true);
      expect(out.snapshot.knownHostsFiles).toEqual([
        "/home/opsuser/.ssh/known_hosts",
        "/home/opsuser/.ssh/known_hosts2",
      ]);
      expect(out.snapshot.certificateFiles).toEqual([]);
      expect(out.snapshot.hostKeyAlias).toBeNull();
      expect(out.snapshot.user).toBeNull(); // -G echoed the connecting account's own default
    }
  });

  it("blocks a CONFIGURED tunnel or permitremoteopen while the default spellings pass", async () => {
    const defaults = await resolveWith("app02", CLEAN_G);
    expect(defaults.out.accepted).toBe(true);

    const tunnel = await resolveWith("app02", `${CLEAN_G.replace("tunnel false", "tunnel yes")}`);
    expect(tunnel.out).toEqual({ accepted: false, code: "unsupported_setting", settings: ["Tunnel"] });

    const remote = await resolveWith("app02", CLEAN_G.replace("permitremoteopen any", "permitremoteopen host:1080"));
    expect(remote.out).toEqual({ accepted: false, code: "unsupported_setting", settings: ["PermitRemoteOpen"] });
  });

  it("reads one HostName plus one Port as ONE route, not a conflict (real configs set both)", async () => {
    const { out } = await resolveWith("app02", CLEAN_G, {
      configBody: ["Host app02", "  HostName resolved.example", "  Port 2222"].join("\n"),
    });
    expect(out.accepted).toBe(true);
  });

  it("maps a config ProxyCommand to a named refusal naming the keyword", async () => {
    const { out } = await resolveWith("app02", `${CLEAN_G}\nproxycommand nc -X proxy 443 %h %p`);
    expect(out).toEqual({ accepted: false, code: "unsupported_setting", settings: ["ProxyCommand"] });
  });

  it("refuses each unrepresentable family by name, together when several are set", async () => {
    const { out } = await resolveWith(
      "app02",
      [
        CLEAN_G,
        "locallyforward 8080 localhost:80",
        "permitremoteopen yes",
        "remotecommand /bin/sh",
        "sendenv FOO",
        "localcommand /bin/true",
      ].join("\n"),
    );
    expect(out.accepted).toBe(false);
    if (!out.accepted) {
      expect(out.code).toBe("unsupported_setting");
      expect(out.settings).toEqual(["LocalForward", "PermitRemoteOpen", "LocalCommand", "RemoteCommand", "SendEnv"]);
    }
  });

  it("refuses a Match exec config before the evaluator even decides", async () => {
    const { out } = await resolveWith("app02", CLEAN_G, {
      configBody: "Match exec curl -s trust.example\n  User x\nHost app02\n  HostName resolved.example\n",
    });
    expect(out).toEqual({ accepted: false, code: "unsupported_setting", settings: ["Match exec"] });
  });

  it("refuses a hop chain longer than the frozen cap", async () => {
    const hops = ["a.example", "b.example", "c.example", "d.example", "e.example"].join(",");
    const { out } = await resolveWith("app02", `${CLEAN_G}\nproxyjump ${hops}`);
    expect(out).toEqual({ accepted: false, code: "proxy_chain_too_long", settings: [] });
  });

  it("normalizes a bounded ProxyJump chain into approved hops", async () => {
    const { out } = await resolveWith("app02", `${CLEAN_G}\nproxyjump ops@jump.example.com:2222,bastion`);
    expect(out.accepted).toBe(true);
    if (out.accepted) {
      expect(out.snapshot.proxyJumps).toEqual([
        { host: "jump.example.com", user: "ops", port: 2222 },
        { host: "bastion", user: "deploy", port: 22 },
      ]);
    }
  });

  it("treats a token that is not in the config as a manual destination only when -G echoes it as the host", async () => {
    const manual = await resolveWith(
      "fresh.host.example",
      "host fresh.host.example\nhostname fresh.host.example\nuser opsuser\nport 22",
      {
        configBody: "Host something-else\n  HostName elsewhere\n",
      },
    );
    expect(manual.out.accepted).toBe(true);
    if (manual.out.accepted) expect(manual.out.snapshot.host).toBe("fresh.host.example");

    const rewritten = await resolveWith(
      "ghost",
      "host not-the-alias.example\nhostname not-the-alias.example\nuser opsuser\nport 22",
      {
        configBody: "Host unrelated\n  User x\n",
      },
    );
    expect(rewritten.out).toEqual({ accepted: false, code: "config_missing", settings: [] });
  });

  it("resolves a conflicting-Hostname alias to config_ambiguous", async () => {
    const { out } = await resolveWith("app02", CLEAN_G, {
      configBody: ["Host app02", "  Hostname one.example", "Host app02", "  Hostname two.example"].join("\n"),
    });
    expect(out).toEqual({ accepted: false, code: "config_ambiguous", settings: [] });
  });

  it("names the agent socket from the account env, and an explicit IdentityAgent path", async () => {
    const viaEnv = await resolveWith("app02", `${CLEAN_G}\nidentityagent ssh-agent`, {
      env: { SSH_AUTH_SOCK: "/run/user/1000/ssh.sock" },
    });
    expect(viaEnv.out.accepted && viaEnv.out.snapshot.authAgentSocket).toBe("/run/user/1000/ssh.sock");

    const explicit = await resolveWith("app02", `${CLEAN_G}\nidentityagent /home/ops/.ssh/custom-agent.sock`, {
      env: { SSH_AUTH_SOCK: "/run/user/1000/ssh.sock" },
    });
    expect(explicit.out.accepted && explicit.out.snapshot.authAgentSocket).toBe("/home/ops/.ssh/custom-agent.sock");

    const none = await resolveWith("app02", `${CLEAN_G}\nidentityagent none`, {
      env: { SSH_AUTH_SOCK: "/run/user/1000/ssh.sock" },
    });
    expect(none.out.accepted && none.out.snapshot.authAgentSocket).toBeNull();
  });

  it("stores user null when -G reports the connecting account's own default", async () => {
    const out = await resolveWith("app02", CLEAN_G.replace("user deploy", "user opsuser"), { account: "opsuser" });
    expect(out.out.accepted && out.out.snapshot.user).toBeNull();
  });

  it("refuses option-like and empty aliases before spawning anything", async () => {
    const dir = tempRoot("subshell-ssh-resolve-bad-");
    const shim = writeSshShim(join(dir, "bin"), { dashG: CLEAN_G });
    const cfg = gConfig("Host x");
    for (const bad of ["-oProxyCommand=evil", "with space", ""]) {
      const out = await resolveSshAliasConfig(bad, {
        sshBin: shim.bin,
        homeDir: cfg.homeDir,
        configPath: cfg.configPath,
        env: { PATH: "/usr/bin" },
        connectingAccount: "opsuser",
        timeoutMs: 5_000,
      });
      expect(out.accepted).toBe(false);
    }
  });

  it("a failing evaluator answers config_ambiguous, never a crash", async () => {
    const dir = tempRoot("subshell-ssh-resolve-fail-");
    const shim = writeSshShim(join(dir, "bin"), { exitCode: 255, stderr: "bad configuration line" });
    // no dashG: the shim exits 255 for the -G call too.
    const cfg = gConfig("Host app02\n  HostName resolved.example\n");
    const out = await resolveSshAliasConfig("app02", {
      sshBin: shim.bin,
      homeDir: cfg.homeDir,
      configPath: cfg.configPath,
      env: { PATH: "/usr/bin" },
      connectingAccount: "opsuser",
      timeoutMs: 5_000,
    });
    expect(out.accepted).toBe(false);
    if (!out.accepted) expect(out.code).toBe("config_ambiguous");
  });

  // THE C1 pin: the fixture mirror can only be as honest as the hand that
  // wrote it, so the filter is finally run against the REAL host OpenSSH.
  // The loud-skip pattern is `ssh-loopback-sshd.test.ts`'s: no ssh binary,
  // loud warn, every case skipped, the shim suites above still run.
  const HAVE_SSH = Bun.which("ssh") !== null;
  if (!HAVE_SSH) {
    console.warn(
      "[ssh-resolve] ssh not present: REAL `ssh -G` GRAMMAR PIN SKIPPED (loud skip; shim fixtures above mirror 10.x output)",
    );
  }

  describe("against the real host ssh -G", () => {
    it.skipIf(!HAVE_SSH)(
      "accepts an alias with NO explicit IdentityFile (tilde defaults + default tunnel spellings)",
      async () => {
        const cfg = gConfig("Host realg\n  HostName 127.0.0.1\n  Port 2222\n  User targetuser\n");
        const out = await resolveSshAliasConfig("realg", {
          sshBin: Bun.which("ssh") as string,
          homeDir: cfg.homeDir,
          configPath: cfg.configPath,
          env: { PATH: "/usr/bin" },
          connectingAccount: "opsuser",
          timeoutMs: 10_000,
        });
        expect(out.accepted).toBe(true);
        if (out.accepted) {
          expect(out.snapshot.host).toBe("127.0.0.1");
          expect(out.snapshot.port).toBe(2222);
          expect(out.snapshot.user).toBe("targetuser");
          // The whole C1 chain in one assert: real defaults printed, no
          // unsupported_setting (the tunnel/permitremoteopen arms), and no
          // config_ambiguous (the tilde identityfiles expanded).
          expect(out.snapshot.identityFiles.length).toBeGreaterThan(0);
          expect(out.snapshot.identityFiles.every((p) => p.startsWith(`${cfg.homeDir}/.ssh/`))).toBe(true);
        }
      },
      20_000,
    );

    it.skipIf(!HAVE_SSH)(
      "still refuses, by name, what a real config sets",
      async () => {
        const cfg = gConfig(
          "Host realbad\n  HostName 127.0.0.1\n  PermitRemoteOpen host:1080\n  LocalCommand touch /tmp/nope\n",
        );
        const out = await resolveSshAliasConfig("realbad", {
          sshBin: Bun.which("ssh") as string,
          homeDir: cfg.homeDir,
          configPath: cfg.configPath,
          env: { PATH: "/usr/bin" },
          connectingAccount: "opsuser",
          timeoutMs: 10_000,
        });
        expect(out.accepted).toBe(false);
        if (!out.accepted) {
          expect(out.code).toBe("unsupported_setting");
          expect(out.settings).toContain("PermitRemoteOpen");
          expect(out.settings).toContain("LocalCommand"); // the M1 typo, on the real evaluator's own echo
        }
      },
      20_000,
    );
  });
});

describe("parseProxyHop", () => {
  it("parses the whole token grammar", () => {
    expect(parseProxyHop("jump.example.com", null)).toEqual({ host: "jump.example.com", user: null, port: 22 });
    expect(parseProxyHop("ops@jump.example.com:2222", null)).toEqual({
      host: "jump.example.com",
      user: "ops",
      port: 2222,
    });
    expect(parseProxyHop("[2001:db8::1]", null)).toEqual({ host: "[2001:db8::1]", user: null, port: 22 });
    expect(parseProxyHop("ops@[2001:db8::1]:2222", null)).toEqual({
      host: "[2001:db8::1]",
      user: "ops",
      port: 2222,
    });
    expect(parseProxyHop("@jump.example.com", null)).toBeNull();
    expect(parseProxyHop("host:notaport", null)).toBeNull();
    expect(parseProxyHop("host:99999", null)).toBeNull();
    expect(parseProxyHop("host:0", null)).toBeNull();
  });
});
