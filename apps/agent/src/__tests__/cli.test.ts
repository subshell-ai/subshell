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

describe("missing required flags", () => {
  /** The `mote-agent: …` line only — exit 2 always appends the full usage block. */
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
