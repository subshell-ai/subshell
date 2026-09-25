import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, type RunDeps, run } from "../cli.js";
import { loadConfig, saveConfig } from "../config.js";
import { maintenancePath, readMaintenance, writeMaintenance } from "../maintenance.js";
import { SubshellMetaStore } from "../subshell-meta.js";
import { newHome } from "../test-preload.js";
import { darwinServiceStub, LOG, linuxServiceStub, serviceStub, TARGET, UNIT } from "./helpers/service-stub.js";

/** A line only the usage block carries — proof an exit-2 path printed it. */
const USAGE_MARKER = "subshell: node daemon";

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

  test("a second bare token is rejected, naming the subtoken that takes none", () => {
    // `report attention <kind>` introduced a second positional slot; every
    // OTHER subtoken must still refuse one, and say so as itself rather than
    // calling a bare word a flag.
    expect(() => parseArgs(["service", "install", "extra"])).toThrow(/service install takes no argument/);
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

  test("--no-autostart is install's alone", () => {
    expect(parseArgs(["service", "install", "--no-autostart"])).toEqual({
      command: "service",
      sub: "install",
      flags: { noAutostart: "1" },
    });
    // The manager verbs drive a definition whose login behaviour is already
    // written down, so accepting it there would read as meaningful.
    expect(() => parseArgs(["service", "start", "--no-autostart"])).toThrow(/not valid for 'service start'/);
    expect(() => parseArgs(["service", "status", "--no-autostart"])).toThrow(/only 'service install' accepts it/);
  });

  test("the refusal names the subcommand that DOES accept the flag", () => {
    // Both owners, now: `--json` belongs to the view AND the autostart verb.
    expect(() => parseArgs(["service", "install", "--json"])).toThrow(
      /only 'service status' and 'service autostart' accepts it/,
    );
    expect(() => parseArgs(["service", "stop", "--force"])).toThrow(/only 'service restart' accepts it/);
  });

  test("service autostart takes on or off, and nothing else there", () => {
    expect(parseArgs(["service", "autostart", "on"])).toEqual({
      command: "service",
      sub: "autostart",
      arg: "on",
      flags: {},
    });
    expect(parseArgs(["service", "autostart", "off", "--json"]).flags.json).toBe("1");
    // A value slot that is a fixed set: no word means no default, because
    // "which way?" is exactly what this verb is being asked.
    expect(() => parseArgs(["service", "autostart"])).toThrow(/service autostart requires on or off/);
    expect(() => parseArgs(["service", "autostart", "maybe"])).toThrow(
      /unknown service autostart argument 'maybe': requires on or off/,
    );
    // `--no-autostart` is install's flag; the VERB is the day-2 form and
    // carries its state in argv, not in a flag. `--force` belongs to restart.
    expect(() => parseArgs(["service", "autostart", "on", "--no-autostart"])).toThrow(
      /only 'service install' accepts it/,
    );
    expect(() => parseArgs(["service", "autostart", "on", "--force"])).toThrow(/not valid for 'service autostart'/);
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
      "autostart",
      "definitionPath",
      "detail",
      "enabled",
      "installed",
      "linger",
      "logPath",
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
      // The named reading of the same fact, for the consumer that arms and
      // disarms it (Subshell Client's run-at-login switch).
      autostart: true,
      // The stub's logind says this user lingers, so the unit comes back at
      // BOOT rather than only at the next login.
      linger: true,
      paneSafety: "keeps",
      // Linux: the unit redirects nothing — the journal holds the output, and
      // the CONSUMER says so instead of inventing a path.
      logPath: null,
    });
  });

  test("`service status --json` on darwin reports the launchd view", async () => {
    const res = await run(["service", "status", "--json"], { service: darwinServiceStub().deps });
    expect(JSON.parse(res.out)).toMatchObject({
      state: "running",
      pid: 5150,
      paneSafety: "keeps",
      // The plist's own StandardOutPath, so the desktop reveals what launchd
      // actually writes rather than re-deriving the platform path.
      logPath: LOG,
      // The location IS the fact on darwin, and `autostart` is its named
      // reading: this stub's plist sits in ~/Library/LaunchAgents.
      autostart: true,
    });
  });

  test("`service autostart on` arms login start, and touches nothing running", async () => {
    const s = linuxServiceStub();
    const res = await run(["service", "autostart", "on"], { service: s.deps });
    expect(res.code).toBe(0);
    expect(res.out).toInclude("will start at login");
    expect(s.calls.at(-1)).toEqual(["systemctl", "--user", "enable", "--no-reload", "subshell.service"]);
  });

  test("`service autostart off --json` answers the fact the act wrote", async () => {
    const s = linuxServiceStub();
    const res = await run(["service", "autostart", "off", "--json"], { service: s.deps });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toEqual({ ok: true, autostart: false });
    expect(s.calls.at(-1)).toEqual(["systemctl", "--user", "disable", "--no-reload", "subshell.service"]);
  });

  test("`service autostart on --json` keeps a refusal as a refusal: exit 1, words, no JSON", async () => {
    // The installed check is the whole gate, and a script must not be able
    // to read `{ok:false}` comfort where the machine said "nothing
    // installed". (The success shape above is the only thing JSONed.)
    const s = serviceStub();
    const res = await run(["service", "autostart", "on", "--json"], { service: s.deps });
    expect(res.code).toBe(1);
    expect(res.err).toInclude("nothing installed");
    expect(res.out).toBe("");
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

  // The flag has to REACH installService, which is the half a parser test
  // cannot see: `service install` with no flag must keep arming login start.
  test("`service install --no-autostart` runs it now and leaves login start unarmed", async () => {
    const armed = serviceStub();
    expect((await run(["service", "install"], { service: armed.deps })).code).toBe(0);
    expect(armed.calls).toContainEqual(["systemctl", "--user", "enable", "--now", "subshell.service"]);

    const disarmed = serviceStub();
    const res = await run(["service", "install", "--no-autostart"], { service: disarmed.deps });
    expect(res.code).toBe(0);
    expect(disarmed.calls).toContainEqual(["systemctl", "--user", "disable", "subshell.service"]);
    expect(disarmed.calls).toContainEqual(["systemctl", "--user", "start", "subshell.service"]);
    expect(res.out).toInclude("not enabled at login");
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

describe("configure — repoint an enrolled node", () => {
  const enrolled = {
    serverUrl: "http://localhost:3080",
    nodeId: "11111111-2222-3333-4444-555555555555",
    nodeKey: "subshell_secret_never_printed",
    controlPublicKey: '{"kty":"EC","crv":"P-256"}',
    dataDir: "/tmp/node-data",
    name: "workstation",
    nodeWsUrl: "ws://localhost:3080/ws/node",
  };

  test("`configure --server` exits 0 and reports the new address", async () => {
    newHome();
    await saveConfig(enrolled);
    const result = await run(["configure", "--server", "https://subshell.example"]);
    expect(result.code).toBe(0);
    expect(result.out).toInclude("https://subshell.example");
  });

  /**
   * Same rule as `enroll --json` and `status --json`: the node key's only home
   * is the 0600 config file. A GUI drives this command, so a leak here would
   * land the bearer credential in a webview.
   */
  test("--json carries the address and identity but NEVER the node key", async () => {
    newHome();
    await saveConfig(enrolled);
    const result = await run(["configure", "--server", "https://subshell.example", "--json"]);
    expect(result.code).toBe(0);
    expect(result.out).not.toInclude(enrolled.nodeKey);
    const body = JSON.parse(result.out);
    expect(body).toMatchObject({
      nodeId: enrolled.nodeId,
      serverUrl: "https://subshell.example",
      name: "workstation",
    });
    expect(body.nodeKey).toBeUndefined();
  });

  test("the human line says a restart is what applies it", async () => {
    newHome();
    await saveConfig(enrolled);
    const result = await run(["configure", "--server", "https://subshell.example"]);
    expect(result.out).toMatch(/restart/i);
  });

  test("an unusable --server is exit 1 with the reason, not a usage dump", async () => {
    newHome();
    await saveConfig(enrolled);
    const result = await run(["configure", "--server", "subshell.example"]);
    expect(result.code).toBe(1);
    expect(result.err).toInclude("--server");
    expect(result.err).not.toInclude(USAGE_MARKER);
  });

  test("no --server is a usage error (exit 2)", async () => {
    newHome();
    await saveConfig(enrolled);
    const result = await run(["configure"]);
    expect(result.code).toBe(2);
    expect(result.err).toInclude(USAGE_MARKER);
  });

  test("with no config, exit 1 pointing at enroll", async () => {
    newHome();
    const result = await run(["configure", "--server", "https://subshell.example"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/enroll/i);
  });

  test("rejects the flags it has no business taking", () => {
    // `--registry-url` is not even a KNOWN flag anymore (inversion §6 removed
    // the plugin concept the mirror fed), so it refuses before any per-command
    // question is asked.
    expect(() => parseArgs(["configure", "--registry-url", "http://mirror.internal:4873"])).toThrow(
      /unknown flag '--registry-url'/,
    );
    expect(() => parseArgs(["configure", "--probe"])).toThrow(/not valid for 'configure'/);
    // No --name: the plane owns a node's name, so offering one here would
    // promise a rename this command cannot deliver (see configure.ts).
    expect(() => parseArgs(["configure", "--name", "laptop"])).toThrow(/not valid for 'configure'/);
  });

  /**
   * `--key` PARSES (the flag arrived with the rotated-key story: the plane
   * shows the replacement once and there was nowhere to put it), but a
   * `nsk_` value is still refused — as the command's own exit 1 with the
   * sentence that names the right verb, NOT as a usage dump. The shape test
   * belongs to the runtime, which is where the distinction between the two
   * key kinds is worth explaining to the person holding the wrong one.
   */
  test("--key stores a rotated node key and never prints it", async () => {
    newHome();
    await saveConfig(enrolled);
    const result = await run(["configure", "--key", "subshell_rotated_rotated_1"]);
    expect(result.code).toBe(0);
    expect(result.out).not.toInclude("subshell_rotated_rotated_1");
    expect(result.out).toMatch(/rotated node key/i);
    expect(result.out).toMatch(/restart/i);
    expect((await loadConfig()).nodeKey).toBe("subshell_rotated_rotated_1");
    // The identity rule survives the write path: same nodeId, same plane.
    expect((await loadConfig()).nodeId).toBe(enrolled.nodeId);
  });

  test("--key --json says the write happened without repeating the secret", async () => {
    newHome();
    await saveConfig(enrolled);
    const result = await run(["configure", "--key", "subshell_rotated_rotated_1", "--json"]);
    expect(result.code).toBe(0);
    expect(result.out).not.toInclude("subshell_rotated_rotated_1");
    const body = JSON.parse(result.out);
    expect(body.keyUpdated).toBe(true);
    expect(body.nodeKey).toBeUndefined();
    // A --server-only call stays byte-identical to what it always returned.
    const plain = await run(["configure", "--server", "https://subshell.example", "--json"]);
    expect(JSON.parse(plain.out).keyUpdated).toBeUndefined();
  });

  test("--key with a SETUP key is exit 1 naming the right verb, not a usage dump", async () => {
    newHome();
    await saveConfig(enrolled);
    const result = await run(["configure", "--key", "nsk_test_0123456789"]);
    expect(result.code).toBe(1);
    expect(result.err).toInclude("SETUP key");
    expect(result.err).toInclude("subshell setup");
    expect(result.err).not.toInclude(USAGE_MARKER);
    expect((await loadConfig()).nodeKey).toBe(enrolled.nodeKey);
  });

  test("usage lists configure beside enroll", async () => {
    const result = await run(["frobnicate"]);
    expect(result.err).toInclude("subshell configure");
  });
});

describe("dashboard verb (spec 2026-09-19)", () => {
  test("the flag parses, with a value; the command slot accepts the verb", () => {
    const parsed = parseArgs(["dashboard", "--dashboard-port", "31998"]);
    expect(parsed.command).toBe("dashboard");
    expect(parsed.flags.dashboardPort).toBe("31998");
    expect(() => parseArgs(["dashboard", "--dashboard-port"])).toThrow(/requires a value/);
  });

  test("run accepts the same port flag", () => {
    expect(parseArgs(["run", "--dashboard-port", "0"]).flags.dashboardPort).toBe("0");
  });

  test("a non-numeric port is a usage error before anything binds", async () => {
    const res = await run(["dashboard", "--dashboard-port", "http://nope"]);
    expect(res.code).toBe(2);
    expect(res.out).toBe("");
    expect(res.err).toInclude("not a port");
  });

  test("the unenrolled machine gets the enroll-pointing refusal, not a server", async () => {
    // newHome() means no config.json; the verb answers code 1 with the
    // pointer — the same operational refusal every config-reading verb
    // (`configure`, `status`, `run`, `maintenance`, `update`) gives for a
    // machine with nothing enrolled. (`setup` is the exception: it CREATES the
    // enrollment, so an unenrolled machine is its happy path, not a refusal.)
    // `parseArgs` and the port flag are the usage (exit 2) half; a missing
    // config is the operational-refusal (exit 1) half.
    newHome();
    const res = await run(["dashboard"]);
    expect(res.code).toBe(1);
    expect(res.err.length).toBeGreaterThan(0);
    expect(res.err).toInclude("subshell enroll");
  });

  test("usage lists the verb beside run", async () => {
    const res = await run(["frobnicate"]);
    expect(res.err).toInclude("subshell dashboard");
  });
});

describe("plugin is gone from the CLI (inversion §6)", () => {
  test("`plugin` is an unknown command now, in every position", () => {
    expect(() => parseArgs(["plugin"])).toThrow(/unknown command 'plugin'/);
    expect(() => parseArgs(["plugin", "list"])).toThrow(/unknown command 'plugin'/);
  });
  test("bare positional tokens everywhere still die as unknown flags", () => {
    // The `plugin` verbs were the only positional-taking subcommands; their
    // removal must not turn `service status extra` or `status extra` into
    // accepted no-ops.
    expect(() => parseArgs(["status", "extra"])).toThrow(/unknown flag 'extra'/);
    expect(() => parseArgs(["service", "install", "extra"])).toThrow(/service install takes no argument/);
  });
});

/**
 * `subshell maintenance on|off|status` (spec 2026-09-14 §4.5) — the operator's
 * half of the flag, driven against stubbed tmux/meta seams so no test needs a
 * tmux server. The plane's half is `set_maintenance`
 * (`commands-maintenance.test.ts`).
 */
describe("maintenance verb", () => {
  const A = "aaaaaaaa-1111-4111-8111-111111111111";
  const B = "bbbbbbbb-2222-4222-8222-222222222222";
  const NOW = "2026-09-14T10:00:00.000Z";
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** An enrolled config over a fresh data dir, plus stub deps and the kill recorder. */
  async function enrolled(
    alive: string[] = [],
    stubborn: string[] = [],
  ): Promise<{
    dataDir: string;
    deps: RunDeps;
    killed: Array<{ socket: string; id: string }>;
    meta: SubshellMetaStore;
  }> {
    newHome();
    const dataDir = mkdtempSync(join(tmpdir(), "subshell-cli-maint-"));
    dirs.push(dataDir);
    await saveConfig({
      serverUrl: "http://localhost:3080",
      nodeId: "11111111-2222-3333-4444-555555555555",
      nodeKey: "subshell_secret_never_printed",
      controlPublicKey: '{"kty":"EC","crv":"P-256"}',
      dataDir,
      name: "workstation",
    });
    const meta = new SubshellMetaStore(dataDir);
    const aliveSet = new Set(alive);
    const stubbornSet = new Set(stubborn);
    const killed: Array<{ socket: string; id: string }> = [];
    return {
      dataDir,
      meta,
      killed,
      deps: {
        maintenance: {
          meta,
          tmux: {
            hasSubshell: async (_socket: string, id: string) => aliveSet.has(id),
            killSubshell: (socket: string, id: string) => {
              // Mirrors the real runner: SYNCHRONOUS and error-swallowing, so
              // a pane that refuses to die returns just like one that died.
              killed.push({ socket, id });
              if (!stubbornSet.has(id)) aliveSet.delete(id);
            },
          },
          now: () => Date.parse(NOW),
        },
      },
    };
  }

  /** Record one launched subshell exactly as a launch would have. */
  async function record(meta: SubshellMetaStore, id: string, name: string, cwd: string): Promise<void> {
    await meta.record({ subshellId: id, cwd, socket: `sock-${name}`, harnessId: "claude-code", name, startedAt: NOW });
  }

  test("`on` with live panes and no --yes refuses, names them, and writes NOTHING", async () => {
    const { dataDir, deps, meta, killed } = await enrolled([A, B]);
    await record(meta, A, "alpha", "/work/alpha");
    await record(meta, B, "beta", "/work/beta");

    const res = await run(["maintenance", "on"], deps);

    expect(res.code).toBe(1);
    expect(res.out).toBe("");
    expect(res.err).toInclude("--yes");
    for (const [name, id, cwd] of [
      ["alpha", A, "/work/alpha"],
      ["beta", B, "/work/beta"],
    ]) {
      expect(res.err).toInclude(name);
      expect(res.err).toInclude(id);
      expect(res.err).toInclude(cwd);
    }
    // The refusal is total: nothing stopped, and no flag anyone would have to
    // undo. (A written flag with the panes still up is the worst of both.)
    expect(killed).toEqual([]);
    expect(readMaintenance(dataDir)).toEqual({ kind: "absent" });
  });

  test("`on --yes` writes the flag FIRST, then stops every live pane", async () => {
    const { dataDir, deps, meta, killed } = await enrolled([A, B]);
    await record(meta, A, "alpha", "/work/alpha");
    await record(meta, B, "beta", "/work/beta");

    const res = await run(["maintenance", "on", "--yes"], deps);

    expect(res.code).toBe(0);
    expect(readMaintenance(dataDir)).toEqual({ kind: "state", state: { on: true, changedAt: NOW } });
    expect(killed).toEqual([
      { socket: "sock-alpha", id: A },
      { socket: "sock-beta", id: B },
    ]);
    expect(res.out).toInclude("2");
  });

  test("`on --yes` leaves the meta records alone — with no daemon they ARE the census", async () => {
    // A kill without a record is a pane the reconnect census cannot report,
    // so the plane would keep the row `running` forever with nothing to
    // contradict it.
    const { dataDir, deps, meta } = await enrolled([A]);
    await record(meta, A, "alpha", "/work/alpha");

    await run(["maintenance", "on", "--yes"], deps);

    expect(existsSync(join(dataDir, "subshells", `${A}.meta.json`))).toBe(true);
    expect(await meta.list()).toHaveLength(1);
  });

  test("`on` needs no --yes when nothing is running", async () => {
    const { dataDir, deps, meta, killed } = await enrolled([]);
    await record(meta, A, "alpha", "/work/alpha"); // recorded but dead: nothing to stop
    const res = await run(["maintenance", "on"], deps);
    expect(res.code).toBe(0);
    expect(killed).toEqual([]);
    expect(readMaintenance(dataDir)).toEqual({ kind: "state", state: { on: true, changedAt: NOW } });
  });

  test("`on --yes` counts a pane as stopped only when the socket says it is gone", async () => {
    // `killSubshell` is synchronous and swallows its own errors, so a
    // try/catch around it can never fire: without a re-probe every row would
    // be reported stopped, including the one still running. The flag is
    // written either way — the machine IS in maintenance — so this is a
    // report, not a failure, and the exit stays 0.
    const { deps, meta } = await enrolled([A, B], [B]);
    await record(meta, A, "alpha", "/work/alpha");
    await record(meta, B, "beta", "/work/beta");

    const res = await run(["maintenance", "on", "--yes"], deps);

    expect(res.code).toBe(0);
    expect(res.out).toInclude("1");
    expect(res.err).toInclude(B);
    expect(res.err).not.toInclude(A);
  });

  test("`on --yes --json` excludes a surviving pane from `stopped`", async () => {
    const { deps, meta } = await enrolled([A, B], [B]);
    await record(meta, A, "alpha", "/work/alpha");
    await record(meta, B, "beta", "/work/beta");

    const res = await run(["maintenance", "on", "--yes", "--json"], deps);

    expect(res.code).toBe(0);
    // `failed` carries the RAW id for exactly this case: the node dashboard's
    // partial-flip wording is built from the list, and a consumer handed the
    // decorated stderr line would have to parse display text to count panes.
    expect(JSON.parse(res.out)).toEqual({ on: true, changedAt: NOW, stopped: [A], failed: [B] });
    expect(res.err).toInclude(B);
  });

  test("`on --yes --json` reports the stamp and exactly what it stopped", async () => {
    const { deps, meta } = await enrolled([A]);
    await record(meta, A, "alpha", "/work/alpha");
    const res = await run(["maintenance", "on", "--yes", "--json"], deps);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toEqual({ on: true, changedAt: NOW, stopped: [A] });
  });

  test("`off` writes the flag and says when the plane will learn of it", async () => {
    const { dataDir, deps } = await enrolled();
    writeMaintenance(dataDir, { on: true, changedAt: "2026-09-13T00:00:00.000Z" });

    const res = await run(["maintenance", "off"], deps);

    expect(res.code).toBe(0);
    expect(readMaintenance(dataDir)).toEqual({ kind: "state", state: { on: false, changedAt: NOW } });
    expect(res.out).toMatch(/15 seconds|next connect/);
  });

  test("`off` REPAIRS an unreadable mirror — the only way out of the fail-closed state", async () => {
    // Fail-closed means a corrupt file refuses every launch, so the escape
    // hatch has to be a test rather than a paragraph: `off` never reads before
    // writing, and the write is a wholesale replace, so the corrupt bytes are
    // gone and the gate passes again.
    const { dataDir, deps } = await enrolled();
    writeFileSync(maintenancePath(dataDir), "{not json");
    expect(readMaintenance(dataDir).kind).toBe("unreadable");

    const res = await run(["maintenance", "off"], deps);

    expect(res.code).toBe(0);
    expect(readMaintenance(dataDir)).toEqual({ kind: "state", state: { on: false, changedAt: NOW } });
  });

  test("the refusal stays TEXT under --json — the exit code is the contract, not stdout", async () => {
    const { dataDir, deps, meta, killed } = await enrolled([A]);
    await record(meta, A, "alpha", "/work/alpha");

    const res = await run(["maintenance", "on", "--json"], deps);

    expect(res.code).toBe(1);
    // Nothing on stdout at all: a caller that got code 1 must not be parsing
    // it, and half a JSON document would invite exactly that.
    expect(res.out).toBe("");
    expect(res.err).toInclude("--yes");
    expect(res.err).toInclude(A);
    expect(killed).toEqual([]);
    expect(readMaintenance(dataDir)).toEqual({ kind: "absent" });
  });

  test("`status` reports each of the three file states, and never exits non-zero", async () => {
    const { dataDir, deps } = await enrolled();

    const absent = await run(["maintenance", "status", "--json"], deps);
    expect(absent.code).toBe(0);
    expect(JSON.parse(absent.out)).toEqual({ on: false, changedAt: null, file: "absent" });

    writeMaintenance(dataDir, { on: true, changedAt: NOW });
    const on = await run(["maintenance", "status", "--json"], deps);
    expect(on.code).toBe(0);
    expect(JSON.parse(on.out)).toEqual({ on: true, changedAt: NOW, file: "present" });
    expect((await run(["maintenance", "status"], deps)).out).toInclude(NOW);

    writeFileSync(maintenancePath(dataDir), "{not json");
    const broken = await run(["maintenance", "status", "--json"], deps);
    expect(broken.code).toBe(0);
    // Fail-closed, and the view says so rather than reporting a tidy "off".
    // RE-BASED: `changedAt` was null here while the plane held the file's
    // mtime — two answers for one file, read by the person most likely to be
    // comparing this screen against the node page mid-incident. `file` stays
    // the discriminator that says where the stamp came from.
    const mtime = statSync(maintenancePath(dataDir)).mtime.toISOString();
    expect(JSON.parse(broken.out)).toEqual({ on: true, changedAt: mtime, file: "unreadable" });
    const brokenText = (await run(["maintenance", "status"], deps)).out;
    expect(brokenText).toMatch(/unreadable/);
    expect(brokenText).toInclude(mtime);
  });

  test("with no config, exit 1 pointing at enroll", async () => {
    newHome();
    const res = await run(["maintenance", "status"]);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/enroll/i);
  });

  test("subtoken and flag placement are usage errors (exit 2)", async () => {
    expect(() => parseArgs(["maintenance"])).toThrow(/maintenance requires on or off or status/);
    expect(() => parseArgs(["maintenance", "drain"])).toThrow(/unknown maintenance subcommand 'drain'/);
    // --yes only overrides `on`'s refusal; nothing else has one to override.
    expect(() => parseArgs(["maintenance", "off", "--yes"])).toThrow(/not valid for 'maintenance off'/);
    expect(() => parseArgs(["maintenance", "status", "--yes"])).toThrow(/not valid for 'maintenance status'/);
    expect(parseArgs(["maintenance", "on", "--yes", "--json"])).toEqual({
      command: "maintenance",
      sub: "on",
      flags: { yes: "1", json: "1" },
    });
    const res = await run(["maintenance", "drain"]);
    expect(res.code).toBe(2);
    expect(res.err).toInclude(USAGE_MARKER);
  });

  test("usage lists the verb", async () => {
    expect((await run(["frobnicate"])).err).toInclude("subshell maintenance");
  });
});

describe("update verb (spec 2026-09-15 §5.2)", () => {
  test("takes its flags, and no subtoken — --rollback is a flag, not a subcommand", () => {
    // A `subshell update rollback` subcommand would invite `update rollback
    // --to 0.8.0`, which means nothing. As a flag it is plainly the same verb
    // pointed backwards, and the mutual exclusions below say so.
    expect(parseArgs(["update"])).toEqual({ command: "update", flags: {} });
    expect(parseArgs(["update", "--check"])).toEqual({ command: "update", flags: { check: "1" } });
    expect(parseArgs(["update", "--to", "0.9.1"]).flags.to).toBe("0.9.1");
    expect(parseArgs(["update", "--from", "/tmp/subshell"]).flags.from).toBe("/tmp/subshell");
    expect(parseArgs(["update", "--no-restart"]).flags.noRestart).toBe("1");
    expect(parseArgs(["update", "--rollback", "--yes"]).flags.rollback).toBe("1");
  });

  test("rejects flags that belong to other verbs", () => {
    expect(() => parseArgs(["update", "--probe"])).toThrow(/not valid for 'update'/);
    expect(() => parseArgs(["update", "--server", "http://x"])).toThrow(/not valid for 'update'/);
    // And the new flags are refused everywhere they mean nothing.
    expect(() => parseArgs(["status", "--rollback"])).toThrow(/not valid for 'status'/);
    expect(() => parseArgs(["service", "restart", "--to", "1"])).toThrow(/not valid for 'service'/);
  });

  test("--rollback refuses to be combined with a forward flag", async () => {
    newHome();
    // Usage, not a runtime failure: the two describe opposite directions, and
    // silently ignoring one would install a version while reporting a rollback.
    await saveConfig({
      serverUrl: "http://localhost:1",
      nodeId: "n1",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir: mkdtempSync(join(tmpdir(), "subshell-cli-update-")),
      name: "n",
    });
    const res = await run(["update", "--rollback", "--to", "0.9.1"]);
    expect(res.code).toBe(2);
    expect(res.err).toMatch(/--rollback cannot be combined with --to/);
  });

  test("--from and --to together are a usage error", async () => {
    newHome();
    await saveConfig({
      serverUrl: "http://localhost:1",
      nodeId: "n1",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir: mkdtempSync(join(tmpdir(), "subshell-cli-update-")),
      name: "n",
    });
    const res = await run(["update", "--from", "/tmp/x", "--to", "0.9.1"]);
    expect(res.code).toBe(2);
    expect(res.err).toMatch(/Use one or the other/);
  });

  test("with no config, exit 1 pointing at enroll", async () => {
    // The markers live in the enrolled data dir, so a machine that was never
    // enrolled has nowhere to record a transaction — the same first move
    // `maintenance` makes.
    newHome();
    const res = await run(["update", "--check"]);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/enroll/i);
  });

  test("--check refuses when the release source is disabled, pointing at --from", async () => {
    newHome();
    await saveConfig({
      serverUrl: "http://localhost:1",
      nodeId: "n1",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir: mkdtempSync(join(tmpdir(), "subshell-cli-update-")),
      name: "n",
    });
    const before = process.env.SUBSHELL_RELEASE_URL;
    process.env.SUBSHELL_RELEASE_URL = "";
    try {
      const res = await run(["update", "--check"]);
      expect(res.code).toBe(1);
      expect(res.err).toMatch(/--from/);
    } finally {
      if (before === undefined) delete process.env.SUBSHELL_RELEASE_URL;
      else process.env.SUBSHELL_RELEASE_URL = before;
    }
  });

  /**
   * A fake agent binary that answers `<path> version` with whatever version it
   * was built for — which is all `probeFileVersion` reads, so it is all a
   * `--from` offer needs to be believed.
   */
  const fakeNodeCli = (version: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "subshell-cli-fake-"));
    const path = join(dir, "subshell");
    writeFileSync(path, `#!/bin/sh\necho "subshell ${version} (node protocol 10)"\n`, { mode: 0o755 });
    return path;
  };

  const enrolled = async () => {
    newHome();
    await saveConfig({
      serverUrl: "http://localhost:1",
      nodeId: "n1",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir: mkdtempSync(join(tmpdir(), "subshell-cli-update-")),
      name: "n",
    });
  };

  /**
   * The comparison is SEMVER, and `!==` is not the same question.
   *
   * It bites in an ordinary state rather than a contrived one: `MIN_NODE_VERSION`
   * and this package are bumped in the SAME commit as a protocol change, so
   * between that commit and the matching `cli-node-v*` cut the newest published
   * release is genuinely older than the running agent. Under `!==` that read
   * as "available", and a bare `subshell update` then downloaded ~70 MB,
   * swapped the binary, restarted, and was held by the plane's own version
   * floor — the exact state the update exists to get a machine out of.
   */
  test("--check calls an OLDER offer unavailable rather than merely different", async () => {
    await enrolled();
    const res = await run(["update", "--check", "--from", fakeNodeCli("0.0.1"), "--json"]);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.out) as { installed: string; latest: string; updateAvailable: boolean };
    expect(body.latest).toBe("0.0.1");
    expect(body.updateAvailable).toBe(false);
  });

  test("refuses to install a version older than the running one without --force", async () => {
    await enrolled();
    const res = await run(["update", "--from", fakeNodeCli("0.0.1"), "--yes", "--no-restart"]);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/older than the running/);
    expect(res.err).toMatch(/--force/);
  });

  test("usage lists the verb and its rollback form", async () => {
    const err = (await run(["frobnicate"])).err;
    expect(err).toInclude("subshell update");
    expect(err).toInclude("--rollback");
  });
});
