import { describe, expect, test } from "bun:test";
import { parseArgs, run } from "../cli.js";
import { saveConfig } from "../config.js";
import { newHome } from "../test-preload.js";
import { darwinServiceStub, linuxServiceStub, serviceStub, TARGET, UNIT } from "./helpers/service-stub.js";

/** A line only the usage block carries — proof an exit-2 path printed it. */
const USAGE_MARKER = "subshell — node agent daemon";

describe("--flag=value parsing", () => {
  test("=-form fills the same flag map as the space form", () => {
    const eq = parseArgs(["enroll", "--server=http://x:1", "--key=nsk_test_0123456789", "--data-dir=/tmp/d"]);
    const space = parseArgs([
      "enroll",
      "--server",
      "http://x:1",
      "--key",
      "nsk_test_0123456789",
      "--data-dir",
      "/tmp/d",
    ]);
    expect(eq.flags).toEqual(space.flags);
    expect(eq.flags.server).toBe("http://x:1");
    expect(eq.flags.dataDir).toBe("/tmp/d");
  });

  test("splits on the FIRST '=' — values may contain '=' and spaces", () => {
    expect(parseArgs(["enroll", "--name=a=b"]).flags.name).toBe("a=b");
    expect(parseArgs(["enroll", "--server=http://x/a b"]).flags.server).toBe("http://x/a b");
  });

  test("--flag= with nothing after the = is a missing value, not an empty one", () => {
    expect(() => parseArgs(["enroll", "--server="])).toThrow(/--server.*requires a value/);
  });

  test("boolean flags reject the =-form", () => {
    expect(() => parseArgs(["status", "--json=true"])).toThrow(/--json.*takes no value/);
    expect(parseArgs(["status", "--json"]).flags.json).toBe("1");
  });
});

describe("service subtoken parsing", () => {
  // NOTE: only the parser and the usage-error paths are exercised here — a
  // successful `run(["service","install"])` would drive the REAL systemctl,
  // so the happy paths live in service.test.ts against stubbed deps.
  test("captures a bare install/uninstall subtoken after `service`", () => {
    expect(parseArgs(["service", "install"])).toEqual({ command: "service", sub: "install", flags: {} });
    expect(parseArgs(["service", "uninstall"])).toEqual({ command: "service", sub: "uninstall", flags: {} });
  });

  test("the manager verbs and the read-only view are subtokens too", () => {
    for (const sub of ["status", "start", "stop", "restart"]) {
      expect(parseArgs(["service", sub])).toEqual({ command: "service", sub, flags: {} });
    }
  });

  test("commands without subcommands keep returning no sub field", () => {
    expect(parseArgs(["version"])).toEqual({ command: "version", flags: {} });
  });

  test("missing subtoken is a usage error (exit 2)", async () => {
    expect(() => parseArgs(["service"])).toThrow(/service requires install or uninstall/);
    const res = await run(["service"]);
    expect(res.code).toBe(2);
  });

  test("unknown subtoken is a usage error (exit 2) naming the valid ones", async () => {
    expect(() => parseArgs(["service", "destroy"])).toThrow(/unknown service subcommand 'destroy'/);
    const res = await run(["service", "destroy"]);
    expect(res.code).toBe(2);
    expect(res.err).toInclude("install or uninstall");
  });

  test("a second bare token is rejected like an unknown flag", () => {
    expect(() => parseArgs(["service", "install", "extra"])).toThrow(/unknown flag 'extra'/);
  });

  test("each subcommand takes only ITS OWN flags (--json is the view's, --force is restart's)", () => {
    expect(parseArgs(["service", "status", "--json"]).flags.json).toBe("1");
    expect(parseArgs(["service", "restart", "--force"]).flags.force).toBe("1");
    // Superseded expectation: `service` used to take no flags at all. It now
    // takes exactly two, and neither is accepted by a subcommand that would
    // have to ignore it — `service install --force` must not read as meaningful.
    expect(() => parseArgs(["service", "install", "--json"])).toThrow(/not valid for 'service install'/);
    expect(() => parseArgs(["service", "install", "--force"])).toThrow(/not valid for 'service install'/);
    expect(() => parseArgs(["service", "status", "--force"])).toThrow(/not valid for 'service status'/);
    expect(() => parseArgs(["service", "restart", "--json"])).toThrow(/not valid for 'service restart'/);
    expect(() => parseArgs(["service", "stop", "--force"])).toThrow(/not valid for 'service stop'/);
  });

  test("the refusal names the subcommand that DOES accept the flag", () => {
    expect(() => parseArgs(["service", "install", "--json"])).toThrow(/only 'service status' accepts it/);
    expect(() => parseArgs(["service", "stop", "--force"])).toThrow(/only 'service restart' accepts it/);
  });

  test("a stray per-subcommand flag is a usage error (exit 2), not a runtime one", async () => {
    const res = await run(["service", "install", "--json"]);
    expect(res.code).toBe(2);
    expect(res.err).toInclude(USAGE_MARKER);
  });

  test("flags before the subtoken are validated against it all the same", () => {
    expect(parseArgs(["service", "--json", "status"])).toEqual({
      command: "service",
      sub: "status",
      flags: { json: "1" },
    });
    expect(() => parseArgs(["service", "--json", "install"])).toThrow(/not valid for 'service install'/);
  });
});

describe("missing required flags", () => {
  /** The `subshell: …` line only — exit 2 always appends the full usage block. */
  const msgLine = (err: string) => err.split("\n")[0] ?? "";

  test("names exactly the missing flag(s), not the full required set", async () => {
    const noKey = await run(["enroll", "--server", "http://x"]);
    expect(noKey.code).toBe(2);
    expect(msgLine(noKey.err)).toInclude("--key");
    expect(msgLine(noKey.err)).not.toInclude("--server");

    const noServer = await run(["enroll", "--key", "nsk_test_0123456789"]);
    expect(noServer.code).toBe(2);
    expect(msgLine(noServer.err)).toInclude("--server");
    expect(msgLine(noServer.err)).not.toInclude("--key");

    const none = await run(["enroll"]);
    expect(none.code).toBe(2);
    expect(msgLine(none.err)).toInclude("--server <url> and --key <nsk_…>");
  });
});

describe("license", () => {
  // The binary ships bare — a download renamed into ~/.local/bin with no
  // LICENSE beside it — so this subcommand is how a recipient gets the terms
  // Apache-2.0 §4(a) obliges us to hand over.
  test("prints the copyright, the licence and the full-text URL, exit 0", async () => {
    const res = await run(["license"]);
    expect(res.code).toBe(0);
    expect(res.err).toBe("");
    expect(res.out).toContain("Copyright 2026 Disaresta, LLC");
    expect(res.out).toContain("Apache-2.0");
    expect(res.out).toContain("https://github.com/subshell-ai/subshell/blob/main/LICENSE");
    expect(res.out.split("\n")[0]).toMatch(/^subshell \d+\.\d+\.\d+$/);
  });

  // The whole reason `license` is its own subcommand: `version` is a machine
  // contract (the release smoke matches it, scripts parse it), so it must not
  // have grown any of this.
  test("version stays a single line and gains nothing from license", async () => {
    const version = await run(["version"]);
    expect(version.out).toMatch(/^subshell \d+\.\d+\.\d+ \(node protocol v\d+\)\n$/);
    expect(version.out).not.toContain("Copyright");
  });

  test("takes no flags", async () => {
    const res = await run(["license", "--json"]);
    expect(res.code).toBe(2);
  });
});

describe("--version / -v in the command slot", () => {
  // argv[0] IS the command in this parser, so `subshell --version` used to
  // die as `unknown command '--version'` — accurate about the parser and
  // useless to whoever typed the one thing every other CLI answers.
  test("--version and -v resolve to the version command", () => {
    expect(parseArgs(["--version"])).toEqual({ command: "version", sub: undefined, flags: {} });
    expect(parseArgs(["-v"])).toEqual({ command: "version", sub: undefined, flags: {} });
  });

  test("they print exactly what `version` prints, exit 0", async () => {
    const canonical = await run(["version"]);
    expect(canonical.code).toBe(0);
    expect(canonical.out).toMatch(/^subshell \d+\.\d+\.\d+ \(node protocol v\d+\)\n$/);
    for (const alias of [["--version"], ["-v"]]) {
      expect(await run(alias)).toEqual(canonical);
    }
  });

  test("the alias is confined to the FIRST token — elsewhere it stays an unknown flag", async () => {
    // `subshell status --version` is a typo, not a request for the version.
    expect(() => parseArgs(["status", "--version"])).toThrow(/unknown flag '--version'/);
    expect(() => parseArgs(["version", "-v"])).toThrow(/unknown flag '-v'/);
  });

  test("an unknown leading token still reports what was TYPED", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown command '--bogus'/);
  });
});

/**
 * The `service` verbs END TO END through `run()`, with the manager and the
 * filesystem stubbed via {@link RunDeps} — the same seam discipline
 * `service.test.ts` uses, one level up. Without the injection these cases
 * would drive the REAL systemctl/launchctl of whatever machine the suite runs
 * on, and would answer differently on a developer box that happens to have the
 * agent installed.
 */
describe("service commands (stubbed service manager)", () => {
  test("`service status` prints the state view and ALWAYS exits 0, even with nothing installed", async () => {
    const s = serviceStub();
    const res = await run(["service", "status"], { service: s.deps });
    // A view must not make a caller distinguish "not running" from "the call
    // itself failed" — the desktop GUI polls this.
    expect(res.code).toBe(0);
    expect(res.out).toInclude(`not installed (${UNIT})`);
    expect(res.out).toInclude("subshell service install");
    expect(res.out.endsWith("\n")).toBe(true);
    expect(s.calls).toEqual([]); // reading a definition that is not there asks the manager nothing
  });

  test("`service status --json` emits the ServiceState shape verbatim", async () => {
    const s = linuxServiceStub();
    const res = await run(["service", "status", "--json"], { service: s.deps });
    expect(res.code).toBe(0);
    const body = JSON.parse(res.out) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "definitionPath",
      "detail",
      "enabled",
      "installed",
      "paneSafety",
      "pid",
      "state",
    ]);
    expect(body).toMatchObject({
      installed: true,
      definitionPath: UNIT,
      state: "running",
      pid: 4242,
      enabled: true,
      paneSafety: "keeps",
    });
  });

  test("`service status --json` on darwin reports the launchd view", async () => {
    const res = await run(["service", "status", "--json"], { service: darwinServiceStub().deps });
    expect(JSON.parse(res.out)).toMatchObject({ state: "running", pid: 5150, paneSafety: "keeps" });
  });

  // The 0600 config file is the nodeKey's only home (the `status --json` rule),
  // and `service status` must not become the leak the other view refuses to be.
  test("`service status --json` never echoes the node key, even with an enrolled config on disk", async () => {
    const previous = process.env.SUBSHELL_CONFIG_HOME;
    try {
      newHome();
      await saveConfig({
        serverUrl: "http://plane.local:3080",
        nodeId: "node_scan_1",
        nodeKey: "subshell_key_never_printed",
        controlPublicKey: '{"kty":"EC"}',
        dataDir: "/tmp/scan-data",
        name: "scanner",
      });
      const res = await run(["service", "status", "--json"], { service: linuxServiceStub().deps });
      const serialized = `${res.out}${res.err}`;
      expect(serialized).not.toInclude("subshell_key_never_printed");
      expect(serialized).not.toInclude("nodeKey");
    } finally {
      process.env.SUBSHELL_CONFIG_HOME = previous;
    }
  });

  test("start/stop/restart drive the manager and report which verb ran", async () => {
    for (const verb of ["start", "stop", "restart"] as const) {
      const s = linuxServiceStub(verb === "start" ? { ActiveState: "inactive", MainPID: "0" } : {});
      const res = await run(["service", verb], { service: s.deps });
      expect(res.code).toBe(0);
      expect(res.out.trim()).toBe(`subshell ${verb === "stop" ? "stopped" : `${verb}ed`}.`);
      expect(s.calls.at(-1)).toEqual(["systemctl", "--user", verb, "subshell.service"]);
    }
  });

  test("darwin verbs use the explicit gui domain target", async () => {
    const s = darwinServiceStub();
    expect((await run(["service", "restart"], { service: s.deps })).code).toBe(0);
    expect(s.calls.at(-1)).toEqual(["launchctl", "kickstart", "-k", TARGET]);
  });

  // The point of the port: a machine that installed an older agent carries a
  // definition whose teardown SIGKILLs every pane on it.
  test("`service restart` REFUSES a lethal definition (exit 1) and `--force` overrides it", async () => {
    const refused = linuxServiceStub({ KillMode: "control-group" });
    const no = await run(["service", "restart"], { service: refused.deps });
    expect(no.code).toBe(1);
    expect(no.err).toInclude("--force");
    expect(refused.calls.flat()).not.toContain("restart");

    const forced = linuxServiceStub({ KillMode: "control-group" });
    const yes = await run(["service", "restart", "--force"], { service: forced.deps });
    expect(yes.code).toBe(0);
    expect(forced.calls.at(-1)).toEqual(["systemctl", "--user", "restart", "subshell.service"]);
  });

  test("`service stop` warns on a lethal definition but still stops (exit 0)", async () => {
    const s = linuxServiceStub({ KillMode: "control-group" });
    const res = await run(["service", "stop"], { service: s.deps });
    expect(res.code).toBe(0);
    expect(res.err).toInclude("warning");
    expect(s.calls.at(-1)).toEqual(["systemctl", "--user", "stop", "subshell.service"]);
  });

  test("a control verb with nothing installed refuses (exit 1) instead of installing one", async () => {
    const s = serviceStub();
    const res = await run(["service", "start"], { service: s.deps });
    expect(res.code).toBe(1);
    expect(res.err).toInclude("nothing installed");
    expect(s.files.size).toBe(0);
    expect(s.calls).toEqual([]);
  });

  test("install/uninstall still route through the same injected deps", async () => {
    const s = serviceStub();
    expect((await run(["service", "install"], { service: s.deps })).code).toBe(0);
    expect(s.files.has(UNIT)).toBe(true);
    expect((await run(["service", "uninstall"], { service: s.deps })).code).toBe(0);
    expect(s.removed).toEqual([UNIT]);
  });
});
