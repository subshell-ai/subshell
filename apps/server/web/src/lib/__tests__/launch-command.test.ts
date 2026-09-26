import { describe, expect, it } from "bun:test";
import { presetLaunchCommand } from "../launch-command";

describe("presetLaunchCommand", () => {
  it("renders env prefix then binary then flag tokens, quoting only values that need it", () => {
    const cmd = presetLaunchCommand(
      JSON.stringify({ ANTHROPIC_MODEL: "sonnet", ANTHROPIC_BASE_URL: "http://x:4000/a b" }),
      JSON.stringify(["-m", "anthropic/claude-sonnet-4-5", "--auto"]),
      "claude",
    );
    expect(cmd).toEqual(
      'ANTHROPIC_MODEL=sonnet ANTHROPIC_BASE_URL="http://x:4000/a b" claude -m anthropic/claude-sonnet-4-5 --auto',
    );
  });
  it("returns the bare binary when nothing is configured", () => {
    expect(presetLaunchCommand(null, null, "claude")).toEqual("claude");
    expect(presetLaunchCommand("{}", "[]", "claude")).toEqual("claude");
  });
  it("renders env-only and flags-only shapes", () => {
    expect(presetLaunchCommand('{"A":"1"}', null, "pi")).toEqual("A=1 pi");
    expect(presetLaunchCommand(null, '["--auto"]', "pi")).toEqual("pi --auto");
  });
  it("never quotes keys or flag tokens", () => {
    // The names of things are not data: a flag renders as the word it is.
    // (Fixed 2026-09-25: quotePosix single-quoted every token, so the
    // preview read `claude '--dangerously-skip-permissions' '--effort'`
    // where the operator expects `claude --dangerously-skip-permissions --effort`.)
    const cmd = presetLaunchCommand(
      '{"ANTHROPIC_API_KEY":"sk-abc123","ANTHROPIC_BASE_URL":"https://x.dev"}',
      '["--dangerously-skip-permissions","--effort","xhigh","--chrome"]',
      "claude",
    );
    expect(cmd).toEqual(
      "ANTHROPIC_API_KEY=sk-abc123 ANTHROPIC_BASE_URL=https://x.dev claude --dangerously-skip-permissions --effort xhigh --chrome",
    );
  });
  it("gives a flag without a value no token at all", () => {
    // An empty token carries no data, so it must not render as `''` —
    // a valueless flag is the flag alone.
    expect(presetLaunchCommand(null, '["--effort","","xhigh"]', "claude")).toEqual("claude --effort xhigh");
    // An env var deliberately set to empty still says so.
    expect(presetLaunchCommand('{"EMPTY":""}', null, "claude")).toEqual('EMPTY="" claude');
  });
  it("quotes an env value a shell would expand or re-split", () => {
    // `$HOME` single-quotes (double would expand it on paste).
    expect(presetLaunchCommand('{"H":"$HOME","M":"Qwen 3.8"}', null, "claude")).toEqual(
      `H='$HOME' M="Qwen 3.8" claude`,
    );
  });
  it("prints a flag's CLI-arg value verbatim, quotes the person typed included", () => {
    // Operator ruling 2026-09-25: quoting a CLI argument is the user's
    // business, not the renderer's — no added quotes, spaced or not.
    expect(presetLaunchCommand(null, '["--title","be nice"]', "claude")).toEqual("claude --title be nice");
    expect(presetLaunchCommand(null, '["--msg","he said \\"hi\\""]', "claude")).toEqual('claude --msg he said "hi"');
    expect(presetLaunchCommand(null, '["--pattern","$HOME"]', "claude")).toEqual("claude --pattern $HOME");
  });
  it("coerces non-string env values", () => {
    expect(presetLaunchCommand('{"N":5}', null, "claude")).toEqual("N=5 claude");
  });
  it("keeps corrupt blobs from throwing — falls back to what parses", () => {
    expect(presetLaunchCommand("not json", '["--x"]', "claude")).toEqual("claude --x");
    expect(presetLaunchCommand('{"A":"1"}', "]]", "claude")).toEqual("A=1 claude");
  });
});
