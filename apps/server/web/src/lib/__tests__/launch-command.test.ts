import { describe, expect, it } from "bun:test";
import { presetLaunchCommand, quotePosix } from "../launch-command";

describe("quotePosix", () => {
  it("single-quotes a plain value", () => {
    expect(quotePosix("sonnet")).toEqual("'sonnet'");
  });
  it("escapes embedded single quotes shell-style", () => {
    expect(quotePosix("it's")).toEqual(`'it'\\''s'`);
  });
  it("quotes empty and space-bearing values", () => {
    expect(quotePosix("")).toEqual("''");
    expect(quotePosix("be nice")).toEqual("'be nice'");
  });
});

describe("presetLaunchCommand", () => {
  it("renders env prefix then binary then quoted flag tokens", () => {
    const cmd = presetLaunchCommand(
      JSON.stringify({ ANTHROPIC_MODEL: "sonnet", ANTHROPIC_BASE_URL: "http://x:4000/a b" }),
      JSON.stringify(["-m", "anthropic/claude-sonnet-4-5", "--auto"]),
      "claude",
    );
    expect(cmd).toEqual(
      "ANTHROPIC_MODEL='sonnet' ANTHROPIC_BASE_URL='http://x:4000/a b' claude '-m' 'anthropic/claude-sonnet-4-5' '--auto'",
    );
  });
  it("returns the bare binary when nothing is configured", () => {
    expect(presetLaunchCommand(null, null, "claude")).toEqual("claude");
    expect(presetLaunchCommand("{}", "[]", "claude")).toEqual("claude");
  });
  it("renders env-only and flags-only shapes", () => {
    expect(presetLaunchCommand('{"A":"1"}', null, "pi")).toEqual("A='1' pi");
    expect(presetLaunchCommand(null, '["--auto"]', "pi")).toEqual("pi '--auto'");
  });
  it("coerces non-string env values", () => {
    expect(presetLaunchCommand('{"N":5}', null, "claude")).toEqual("N='5' claude");
  });
  it("keeps corrupt blobs from throwing — falls back to what parses", () => {
    expect(presetLaunchCommand("not json", '["--x"]', "claude")).toEqual("claude '--x'");
    expect(presetLaunchCommand('{"A":"1"}', "]]", "claude")).toEqual("A='1' claude");
  });
});
