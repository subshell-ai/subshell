import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProxyHop, resolveSshAliasConfig } from "../ssh-resolve.js";
import { cleanup, tempRoot, writeSshShim } from "./helpers.js";

/**
 * Resolution tests run pane-runtime's resolver against a SHIM ssh that emits
 * canned `ssh -G` output — the shape of the answer is what the filter must
 * decide on, and the shim keeps the decision hermetic. (The real sshd suite
 * in `ssh-sshd-fixture.test.ts` covers the same paths against the actual
 * OpenSSH evaluator; here we test the filter, not OpenSSH.)
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

/** Run the resolver with a shim whose -G output is `gOutput`. */
async function resolveWith(
  alias: string,
  gOutput: string,
  opts: {
    configBody?: string;
    env?: Record<string, string | undefined>;
    account?: string;
  } = {},
) {
  const dir = tempRoot("subshell-ssh-resolve-run-");
  const shim = writeSshShim(join(dir, "bin"), { dashG: gOutput });
  const cfg = gConfig(opts.configBody ?? `Host ${alias}\n  HostName resolved.example\n`);
  return await resolveSshAliasConfig(alias, {
    sshBin: shim.bin,
    homeDir: cfg.homeDir,
    configPath: cfg.configPath,
    env: { PATH: "/usr/bin", HOME: cfg.homeDir, ...opts.env },
    connectingAccount: opts.account ?? "opsuser",
    timeoutMs: 5_000,
  });
}

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
].join("\n");

describe("resolveSshAliasConfig", () => {
  it("normalizes a clean answer into the approved snapshot", async () => {
    const out = await resolveWith("app02", CLEAN_G);
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

  it("maps a config ProxyCommand to a named refusal naming the keyword", async () => {
    const out = await resolveWith("app02", `${CLEAN_G}\nproxycommand nc -X proxy 443 %h %p`);
    expect(out).toEqual({ accepted: false, code: "unsupported_setting", settings: ["ProxyCommand"] });
  });

  it("refuses each unrepresentable family by name, together when several are set", async () => {
    const out = await resolveWith(
      "app02",
      [
        CLEAN_G,
        "locallyforward 8080 localhost:80",
        "permitremoteopen yes",
        "remotecommand /bin/sh",
        "sendenv FOO",
        "localecalcommand /bin/true",
      ].join("\n"),
    );
    expect(out.accepted).toBe(false);
    if (!out.accepted) {
      expect(out.code).toBe("unsupported_setting");
      expect(out.settings).toEqual(["LocalForward", "PermitRemoteOpen", "LocalCommand", "RemoteCommand", "SendEnv"]);
    }
  });

  it("refuses a Match exec config before the evaluator even decides", async () => {
    const out = await resolveWith("app02", CLEAN_G, {
      configBody: "Match exec curl -s trust.example\n  User x\nHost app02\n  HostName resolved.example\n",
    });
    expect(out).toEqual({ accepted: false, code: "unsupported_setting", settings: ["Match exec"] });
  });

  it("refuses a hop chain longer than the frozen cap", async () => {
    const hops = ["a.example", "b.example", "c.example", "d.example", "e.example"].join(",");
    const out = await resolveWith("app02", `${CLEAN_G}\nproxyjump ${hops}`);
    expect(out).toEqual({ accepted: false, code: "proxy_chain_too_long", settings: [] });
  });

  it("normalizes a bounded ProxyJump chain into approved hops", async () => {
    const out = await resolveWith("app02", `${CLEAN_G}\nproxyjump ops@jump.example.com:2222,bastion`);
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
    expect(manual.accepted).toBe(true);
    if (manual.accepted) expect(manual.snapshot.host).toBe("fresh.host.example");

    const rewritten = await resolveWith(
      "ghost",
      "host not-the-alias.example\nhostname not-the-alias.example\nuser opsuser\nport 22",
      {
        configBody: "Host unrelated\n  User x\n",
      },
    );
    expect(rewritten).toEqual({ accepted: false, code: "config_missing", settings: [] });
  });

  it("resolves a conflicting-Hostname alias to config_ambiguous", async () => {
    const out = await resolveWith("app02", CLEAN_G, {
      configBody: ["Host app02", "  Hostname one.example", "Host app02", "  Hostname two.example"].join("\n"),
    });
    expect(out).toEqual({ accepted: false, code: "config_ambiguous", settings: [] });
  });

  it("names the agent socket from the account env, and an explicit IdentityAgent path", async () => {
    const viaEnv = await resolveWith("app02", `${CLEAN_G}\nidentityagent ssh-agent`, {
      env: { SSH_AUTH_SOCK: "/run/user/1000/ssh.sock" },
    });
    expect(viaEnv.accepted && viaEnv.snapshot.authAgentSocket).toBe("/run/user/1000/ssh.sock");

    const explicit = await resolveWith("app02", `${CLEAN_G}\nidentityagent /home/ops/.ssh/custom-agent.sock`, {
      env: { SSH_AUTH_SOCK: "/run/user/1000/ssh.sock" },
    });
    expect(explicit.accepted && explicit.snapshot.authAgentSocket).toBe("/home/ops/.ssh/custom-agent.sock");

    const none = await resolveWith("app02", `${CLEAN_G}\nidentityagent none`, {
      env: { SSH_AUTH_SOCK: "/run/user/1000/ssh.sock" },
    });
    expect(none.accepted && none.snapshot.authAgentSocket).toBeNull();
  });

  it("stores user null when -G reports the connecting account's own default", async () => {
    const out = await resolveWith("app02", CLEAN_G.replace("user deploy", "user opsuser"), { account: "opsuser" });
    expect(out.accepted && out.snapshot.user).toBeNull();
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
    expect(parseProxyHop("ops@[2001:db8::1]:2222", null)).toEqual({ host: "[2001:db8::1]", user: "ops", port: 2222 });
    expect(parseProxyHop("@jump.example.com", null)).toBeNull();
    expect(parseProxyHop("host:notaport", null)).toBeNull();
    expect(parseProxyHop("host:99999", null)).toBeNull();
    expect(parseProxyHop("host:0", null)).toBeNull();
  });
});
