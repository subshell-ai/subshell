import { describe, expect, test } from "bun:test";
import { parseArgs, run } from "../cli.js";

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

  test("service takes no flags", () => {
    expect(() => parseArgs(["service", "install", "--json"])).toThrow(/not valid for 'service'/);
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
