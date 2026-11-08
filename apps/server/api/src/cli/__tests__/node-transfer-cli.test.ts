import { describe, expect, test } from "bun:test";
import { type CliDeps, dispatchCli } from "../dispatch.js";

/**
 * `subshell-server node transfer`: the machine door to the ownership
 * handover (spec 2026-11-07). Dispatch-level coverage of the surface an
 * operator types: the flags, the exits, and the credential hygiene that made
 * `--key-stdin` mandatory (a key in argv is `ps`-visible and shell-history
 * forever, the same accounting `docs/security.md` §11 keeps for the node's
 * own link). The HTTP shape itself is pinned by the route suite.
 */

interface FetchCall {
  url: string;
  init: RequestInit;
}

function harness(overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const calls: FetchCall[] = [];
  // The fake answers the way the route does: it echoes the transfer it was
  // asked to perform, so the human line reflects a real server decision.
  const fetchImpl =
    overrides.fetch ??
    (async (input: string, init: RequestInit) => {
      calls.push({ url: input, init });
      const sent = JSON.parse(String(init.body)) as { toUserId: string; retainAccessAsManager: boolean };
      return Response.json({
        nodeId: "n1",
        ownerUserId: sent.toUserId,
        retainedAccessAsManager: sent.retainAccessAsManager,
      });
    });
  const deps: CliDeps = {
    log: (line) => void out.push(line),
    error: (line) => void err.push(line),
    exit: (code) => void exits.push(code),
    env: {},
    fetch: fetchImpl,
    readKey: async () => " subshell_secret_key\n",
    ...overrides,
  };
  return { deps, out, err, exits, calls };
}

const BASE = ["--base-url", "http://127.0.0.1:3199"];

describe("subshell-server node transfer", () => {
  test("hands the machine over: POST with the stdin key, result printed, key never echoed", async () => {
    const h = harness();
    expect(await dispatchCli(["node", "transfer", "n1", "--to", "u9", "--key-stdin", ...BASE], h.deps)).toBe(true);
    expect(h.exits).toEqual([0]);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]?.url).toBe("http://127.0.0.1:3199/api/nodes/n1/transfer");
    expect(h.calls[0]?.init.method).toBe("POST");
    expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBe("Bearer subshell_secret_key");
    expect(JSON.parse(String(h.calls[0]?.init.body))).toEqual({ toUserId: "u9", retainAccessAsManager: true });
    const stdout = h.out.join("\n");
    expect(stdout).toContain("n1");
    expect(stdout).toContain("u9");
    expect(stdout).not.toContain("subshell_secret_key");
  });

  test("--no-keep-manage transfers clean", async () => {
    const h = harness();
    await dispatchCli(["node", "transfer", "n1", "--to", "u9", "--key-stdin", "--no-keep-manage", ...BASE], h.deps);
    expect(JSON.parse(String(h.calls[0]?.init.body))).toEqual({ toUserId: "u9", retainAccessAsManager: false });
    expect(h.out.join("\n")).toContain("no access retained");
  });

  test("--json answers the machine document", async () => {
    const h = harness();
    await dispatchCli(["node", "transfer", "n1", "--to", "u9", "--key-stdin", "--json", ...BASE], h.deps);
    expect(JSON.parse(h.out.join(""))).toEqual({ nodeId: "n1", ownerUserId: "u9", retainedAccessAsManager: true });
  });

  test("there is no argv spelling of the key: --key is refused and nothing is sent", async () => {
    const h = harness();
    expect(await dispatchCli(["node", "transfer", "n1", "--to", "u9", "--key", "subshell_x", ...BASE], h.deps)).toBe(
      true,
    );
    expect(h.exits).toEqual([1]);
    expect(h.err.join("\n")).toContain("--key-stdin");
    expect(h.calls.length).toBe(0);
  });

  test("the equals form of the refused key flags never echoes the credential, and still names --key-stdin", async () => {
    const h = harness();
    await dispatchCli(["node", "transfer", "n1", "--to", "u9", "--key=subshell_leaky", ...BASE], h.deps);
    expect(h.exits).toEqual([1]);
    // The whole secret lives inside the one argv token, so the refusal must
    // quote the flag's name, never what was typed after the equals sign.
    expect(h.err.join("\n")).not.toContain("subshell_leaky");
    expect(h.err.join("\n")).toContain("--key");
    expect(h.err.join("\n")).toContain("--key-stdin");
    expect(h.calls.length).toBe(0);
  });

  test("--to and --base-url refuse a following flag instead of eating it as their value", async () => {
    // `--to --key-stdin` must not answer "you forgot --key-stdin".
    const eaten = harness();
    await dispatchCli(["node", "transfer", "n1", "--to", "--key-stdin", ...BASE], eaten.deps);
    expect(eaten.exits).toEqual([1]);
    expect(eaten.err.join("\n")).toContain("--to needs");
    expect(eaten.calls.length).toBe(0);

    const urlFlag = harness();
    await dispatchCli(["node", "transfer", "n1", "--to", "u9", "--base-url", "--json"], urlFlag.deps);
    expect(urlFlag.exits).toEqual([1]);
    expect(urlFlag.err.join("\n")).toContain("--base-url needs");
    expect(urlFlag.calls.length).toBe(0);
  });

  test("--json under SUBSHELL_VERBOSE is refused like every other JSON verb", async () => {
    let reads = 0;
    const h = harness({
      env: { SUBSHELL_VERBOSE: "1" },
      readKey: async () => {
        reads += 1;
        return "x";
      },
    });
    await dispatchCli(["node", "transfer", "n1", "--to", "u9", "--key-stdin", "--json", ...BASE], h.deps);
    expect(h.exits).toEqual([1]);
    expect(h.calls.length).toBe(0);
    expect(reads).toBe(0);
  });

  test("without --key-stdin the command refuses before any read or request", async () => {
    let keyReads = 0;
    const h = harness({
      readKey: async () => {
        keyReads += 1;
        return "x";
      },
    });
    await dispatchCli(["node", "transfer", "n1", "--to", "u9", ...BASE], h.deps);
    expect(h.exits).toEqual([1]);
    expect(h.calls.length).toBe(0);
    expect(keyReads).toBe(0);
  });

  test("an empty stdin is named as the problem", async () => {
    const h = harness({ readKey: async () => "   \n" });
    await dispatchCli(["node", "transfer", "n1", "--to", "u9", "--key-stdin", ...BASE], h.deps);
    expect(h.exits).toEqual([1]);
    expect(h.err.join("\n").toLowerCase()).toContain("key");
    expect(h.calls.length).toBe(0);
  });

  test("a server refusal echoes the server's own sentence", async () => {
    const h = harness({
      fetch: async () =>
        Response.json(
          { message: "That account is disabled; re-enable it before transferring a node to it" },
          { status: 400 },
        ),
    });
    await dispatchCli(["node", "transfer", "n1", "--to", "u9", "--key-stdin", ...BASE], h.deps);
    expect(h.exits).toEqual([1]);
    expect(h.err.join("")).toContain("That account is disabled; re-enable it before transferring a node to it");
  });

  test("an unreachable server names the address", async () => {
    const h = harness({
      fetch: async () => {
        throw new TypeError("Unable to connect. Is the computer able to access the url?");
      },
    });
    await dispatchCli(["node", "transfer", "n1", "--to", "u9", "--key-stdin", ...BASE], h.deps);
    expect(h.exits).toEqual([1]);
    expect(h.err.join("")).toContain("http://127.0.0.1:3199");
  });

  test("the equals form of the string flags works like every other verb's", async () => {
    // `subshell-server backup --output=file.tar` has worked for months, so
    // `--to=u9` must not answer "unknown flag" about a flag the usage line
    // just printed.
    const h = harness();
    expect(
      await dispatchCli(
        ["node", "transfer", "n1", "--to=u9", "--key-stdin", "--base-url=http://127.0.0.1:3199"],
        h.deps,
      ),
    ).toBe(true);
    expect(h.exits).toEqual([0]);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]?.url).toBe("http://127.0.0.1:3199/api/nodes/n1/transfer");
    expect(JSON.parse(String(h.calls[0]?.init.body))).toEqual({ toUserId: "u9", retainAccessAsManager: true });
  });

  test("the equals form still refuses an empty or flag-shaped value", async () => {
    const empty = harness();
    await dispatchCli(["node", "transfer", "n1", "--to=", "--key-stdin", ...BASE], empty.deps);
    expect(empty.exits).toEqual([1]);
    expect(empty.err.join("\n")).toContain("--to needs");
    expect(empty.calls.length).toBe(0);

    const flagValue = harness();
    await dispatchCli(["node", "transfer", "n1", "--to=--json", "--key-stdin", ...BASE], flagValue.deps);
    expect(flagValue.exits).toEqual([1]);
    expect(flagValue.err.join("\n")).toContain("--to needs");
    expect(flagValue.calls.length).toBe(0);
  });

  test("a key typed as the base-url value is refused without echoing it", async () => {
    // "The key is never echoed anywhere" has to hold for the value echoes
    // too, not just the positionals: --base-url=subshell_LEAKY reaches the
    // address-validation message.
    const h = harness();
    await dispatchCli(["node", "transfer", "n1", "--to", "u9", "--key-stdin", "--base-url=subshell_LEAKY"], h.deps);
    expect(h.exits).toEqual([1]);
    expect(h.err.join("\n")).not.toContain("subshell_LEAKY");
    expect(h.err.join("\n")).toContain("--base-url");
    expect(h.calls.length).toBe(0);
  });

  test("a key left in a positional slot is refused without echoing it", async () => {
    // The flag-order slip the whole hygiene exists for: a flag slides, the
    // key lands bare, and the parse must not print it back (scrollback, CI
    // logs) or send it in a URL path (server logs carry paths).
    for (const argv of [
      ["node", "transfer", "n1", "--to", "u9", "--key-stdin", "subshell_leakypos", ...BASE],
      ["node", "transfer", "subshell_leakyfirst", "--to", "u9", "--key-stdin", ...BASE],
    ]) {
      const h = harness();
      expect(await dispatchCli(argv, h.deps)).toBe(true);
      expect(h.exits).toEqual([1]);
      const stderr = h.err.join("\n");
      expect(stderr).not.toContain("subshell_leakypos");
      expect(stderr).not.toContain("subshell_leakyfirst");
      expect(stderr.toLowerCase()).toContain("key");
      expect(stderr).toContain("--key-stdin");
      expect(h.calls.length).toBe(0);
    }
  });

  test("an ordinary stray argument still echoes as typed", async () => {
    const h = harness();
    await dispatchCli(["node", "transfer", "n1", "typoed", "--to", "u9", "--key-stdin", ...BASE], h.deps);
    expect(h.exits).toEqual([1]);
    expect(h.err.join("\n")).toContain('unexpected argument "typoed"');
    expect(h.calls.length).toBe(0);
  });

  test("missing parts are refused with the shape of the command", async () => {
    for (const argv of [
      ["node", "transfer", "--key-stdin", ...BASE], // no node
      ["node", "transfer", "n1", "--key-stdin", ...BASE], // no --to
      ["node", "frobnicate", "x"], // no such subcommand
    ]) {
      const h = harness();
      expect(await dispatchCli(argv, h.deps)).toBe(true);
      expect(h.exits).toEqual([1]);
    }
  });
});
