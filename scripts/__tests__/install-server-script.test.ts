import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `install-server.sh` is the control plane's one-liner: it is fetched from
 * raw.githubusercontent and piped straight into bash, so everything it does
 * before the first `chmod +x` is the whole of its safety argument. These tests
 * drive the real script against a fake release host — no release or `cli-server-v*`
 * tag exists yet (spec 2026-09-15 §2.3), and nothing here ever reaches GitHub.
 *
 * What is pinned, and why each one is a defect if it regresses:
 *
 * - the binary lands at `~/.local/bin/subshell-server`, executable;
 * - a digest mismatch installs nothing, executes nothing, and leaves an
 *   already-installed server byte-intact — a re-run of the installer must
 *   never be able to break a working host;
 * - Intel Macs are refused BY NAME rather than resolved to a triple whose
 *   asset 404s;
 * - the setup knobs reach `init` as its own flags;
 * - version resolution picks the newest `cli-server-v*` and ignores every other
 *   component's tags, which share the index.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "install-server.sh");

/** The triple this machine's `uname` resolves to, mirroring the script's case arms. */
function hostTriple(): string {
  if (process.platform === "darwin") return "darwin-arm64";
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

/** Release-asset stem for a triple — `serverArtifactFileName` in `@internal/subshell-protocol`. */
function assetName(triple: string): string {
  return `subshell-server-cli-${triple}`;
}

/**
 * The stand-in for the compiled server: a shell script that records the argv it
 * was invoked with. Its bytes are what the release host serves, so the digest
 * the script verifies is this file's, and "the stub ran" is observable as a
 * file on disk.
 */
const STUB_BINARY = `#!/bin/sh
printf '%s\\n' "$@" > "$SUBSHELL_TEST_ARGV_OUT"
echo "stub init ran"
`;

/** Tags the fake releases index returns — deliberately mixed across components. */
const RELEASE_TAGS = [
  "desktop-client-v2.0.0",
  "cli-node-v9.99.0",
  "cli-server-v1.9.0",
  "cli-server-v1.10.0",
  "desktop-server-v3.1.0",
  "cli-server-v0.4.2",
];

/** Newest `cli-server-v*` above, by semver rather than by string order. */
const NEWEST_SERVER_VERSION = "1.10.0";

/** Mutable server state so one case can serve a digest that does not match the bytes. */
const state = {
  body: STUB_BINARY,
  /** When set, served instead of the real digest of `body`. */
  digestOverride: null as string | null,
  /** HTTP status to answer asset downloads with. */
  assetStatus: 200,
};

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/releases") {
      // Only the field the script greps for; the real API body carries dozens
      // more, which is exactly why the extraction is anchored on `tag_name`.
      const body = RELEASE_TAGS.map((tag) => ({ tag_name: tag, name: tag, draft: false }));
      return Response.json(body);
    }
    if (pathname.endsWith(".sha256")) {
      // A BARE 64-hex digest with no file name — the sidecar shape the release
      // pipeline publishes, and the reason the script pairs the line itself.
      return new Response(`${state.digestOverride ?? sha256Hex(state.body)}\n`);
    }
    if (pathname.startsWith("/download/")) {
      if (state.assetStatus !== 200) return new Response("no", { status: state.assetStatus });
      return new Response(state.body);
    }
    return new Response("not found", { status: 404 });
  },
});

const ORIGIN = `http://127.0.0.1:${server.port}`;
const homes: string[] = [];

afterAll(() => {
  server.stop(true);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  state.body = STUB_BINARY;
  state.digestOverride = null;
  state.assetStatus = 200;
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Where the installer was told HOME is. */
  home: string;
  /** Absolute path the install is expected to land at. */
  dest: string;
  /** Argv the stub recorded, or null when the stub never ran. */
  argv: string[] | null;
}

/**
 * Runs the real script with a throwaway HOME and the release host pointed at
 * the fake server.
 *
 * @param env - Extra environment for the run; `unameShim` installs a PATH shim
 *   so a case can drive the platform detection on a machine of another kind.
 */
async function run(env: Record<string, string> = {}, unameShim?: { s: string; m: string }): Promise<RunResult> {
  const home = mkdtempSync(join(tmpdir(), "subshell-install-server-"));
  homes.push(home);
  const argvOut = join(home, "init-argv.txt");

  let path = process.env.PATH ?? "";
  if (unameShim) {
    // A shim rather than a detection seam: the case arms ARE the thing under
    // test, so forcing them through the same `uname` the script calls is the
    // only version of this that proves the refusal.
    const shimDir = join(home, "shim");
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "uname");
    writeFileSync(
      shim,
      `#!/bin/sh\ncase "$1" in\n  -s) echo "${unameShim.s}" ;;\n  -m) echo "${unameShim.m}" ;;\nesac\n`,
    );
    chmodSync(shim, 0o755);
    path = `${shimDir}:${path}`;
  }

  const proc = Bun.spawn(["bash", SCRIPT], {
    env: {
      ...process.env,
      PATH: path,
      HOME: home,
      SUBSHELL_TEST_ARGV_OUT: argvOut,
      SUBSHELL_SERVER_RELEASE_API: `${ORIGIN}/releases`,
      SUBSHELL_SERVER_RELEASE_BASE: `${ORIGIN}/download`,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    code,
    stdout,
    stderr,
    home,
    dest: join(home, ".local", "bin", "subshell-server"),
    argv: existsSync(argvOut) ? readFileSync(argvOut, "utf8").split("\n").filter(Boolean) : null,
  };
}

describe("install-server.sh", () => {
  test("installs the verified binary and hands over to init", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(existsSync(r.dest)).toBe(true);
    // Executable, and executed: the stub recorded its own argv, so the mode bit
    // is proven by the run rather than by a stat.
    expect(r.argv).toEqual(["init"]);
    expect(r.stdout).toContain("stub init ran");
    expect(readFileSync(r.dest, "utf8")).toBe(STUB_BINARY);
    // No temp files survive a successful install.
    expect(existsSync(`${r.dest}.part`)).toBe(false);
    expect(existsSync(`${r.dest}.part.sha256`)).toBe(false);
  });

  test("asks the release host for this platform's published asset", async () => {
    const r = await run();
    expect(r.stdout).toContain(assetName(hostTriple()));
  });

  test("a digest mismatch installs nothing and runs nothing", async () => {
    state.digestOverride = "0".repeat(64);
    const r = await run();
    expect(r.code).not.toBe(0);
    // Verify-before-chmod, stated three ways: no destination, no stub run, and
    // no half-downloaded file left where a later run could adopt it.
    expect(existsSync(r.dest)).toBe(false);
    expect(r.argv).toBeNull();
    expect(existsSync(`${r.dest}.part`)).toBe(false);
    expect(r.stderr).toContain("checksum mismatch");
  });

  test("a digest mismatch leaves an already-installed server byte-intact", async () => {
    // The realistic shape of this failure is a re-run on a working host: a
    // mismatch must not be able to cost someone their control plane.
    const r1 = await run();
    expect(r1.code).toBe(0);
    const installed = readFileSync(r1.dest, "utf8");

    state.digestOverride = "0".repeat(64);
    const proc = Bun.spawn(["bash", SCRIPT], {
      env: {
        ...process.env,
        HOME: r1.home,
        SUBSHELL_TEST_ARGV_OUT: join(r1.home, "second-argv.txt"),
        SUBSHELL_SERVER_RELEASE_API: `${ORIGIN}/releases`,
        SUBSHELL_SERVER_RELEASE_BASE: `${ORIGIN}/download`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(readFileSync(r1.dest, "utf8")).toBe(installed);
    expect(existsSync(join(r1.home, "second-argv.txt"))).toBe(false);
  });

  test("refuses an Intel Mac by name, before any download", async () => {
    const r = await run({}, { s: "Darwin", m: "x86_64" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Intel Macs are not supported");
    expect(r.stderr).toContain("darwin-x64");
    expect(existsSync(r.dest)).toBe(false);
  });

  test("refuses any other platform by name", async () => {
    const r = await run({}, { s: "Linux", m: "ppc64le" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Linux/ppc64le");
    expect(existsSync(r.dest)).toBe(false);
  });

  test("forwards every setup knob to init as its own flag", async () => {
    const r = await run({
      SUBSHELL_SERVER_PORT: "4100",
      SUBSHELL_SERVER_HOST: "0.0.0.0",
      SUBSHELL_SERVER_BASE_URL: "http://box.local:4100",
      SUBSHELL_SERVER_TRUSTED_ORIGINS: "http://box.local:4100,http://10.0.0.5:4100",
      SUBSHELL_NO_SERVICE: "1",
    });
    expect(r.code).toBe(0);
    expect(r.argv).toEqual([
      "init",
      "--port",
      "4100",
      "--host",
      "0.0.0.0",
      "--base-url",
      "http://box.local:4100",
      "--trusted-origins",
      "http://box.local:4100,http://10.0.0.5:4100",
      "--no-service",
    ]);
  });

  test("SUBSHELL_NO_SERVICE only counts as the exact opt-in", async () => {
    // "0" is a variable somebody left behind, not a request for --no-service.
    const r = await run({ SUBSHELL_NO_SERVICE: "0" });
    expect(r.code).toBe(0);
    expect(r.argv).toEqual(["init"]);
  });

  test("resolves the newest cli-server-v tag and ignores the other components'", async () => {
    const r = await run();
    // 1.10.0 over 1.9.0 is the whole reason this is `sort -V`, and cli-node-v9.99.0
    // shares the index with it.
    expect(r.stdout).toContain(`installing cli-server-v${NEWEST_SERVER_VERSION}`);
    expect(r.stdout).not.toContain("9.99.0");
  });

  test("an explicit version skips the release index entirely", async () => {
    const r = await run({ SUBSHELL_SERVER_VERSION: "0.4.2" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("installing cli-server-v0.4.2");
    expect(r.stdout).not.toContain("finding the newest server release");
  });

  test("a 404 on the asset names the release and the triple", async () => {
    state.assetStatus = 404;
    const r = await run();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`cli-server-v${NEWEST_SERVER_VERSION}`);
    expect(r.stderr).toContain(assetName(hostTriple()));
    expect(existsSync(r.dest)).toBe(false);
  });

  test("survives a HOME with a space in it", async () => {
    // Every path in the script is quoted for this; `sha256sum -c` takes the
    // rest of its line as the file name, so the paired digest line survives too.
    const base = mkdtempSync(join(tmpdir(), "subshell-install-server-"));
    homes.push(base);
    const home = join(base, "a home with spaces");
    mkdirSync(home, { recursive: true });
    const argvOut = join(home, "init-argv.txt");
    const proc = Bun.spawn(["bash", SCRIPT], {
      env: {
        ...process.env,
        HOME: home,
        SUBSHELL_TEST_ARGV_OUT: argvOut,
        SUBSHELL_SERVER_RELEASE_API: `${ORIGIN}/releases`,
        SUBSHELL_SERVER_RELEASE_BASE: `${ORIGIN}/download`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    expect(existsSync(join(home, ".local", "bin", "subshell-server"))).toBe(true);
    expect(existsSync(argvOut)).toBe(true);
  });

  test("states the control plane's own licence, not the repo's permissive half", async () => {
    const text = readFileSync(SCRIPT, "utf8");
    // The NOTICE the recipient sees, not the file's prose: only the lines the
    // script echoes carry the claim. A piped install is a distribution and one
    // bare binary is all that lands, so apps/server/**'s own licence is what
    // must be named — saying Apache here would be wrong about the very thing
    // being installed.
    const notice = text
      .split("\n")
      .filter((line) => line.trimStart().startsWith("echo") && /Copyright|licen[cs]e|AGPL|Apache/i.test(line))
      .join("\n");
    expect(notice).toContain("AGPL-3.0-only");
    expect(notice).not.toContain("Apache-2.0");
    expect(notice).toContain("license for the full notice");

    // The copyright line cannot import the protocol constant — the script is a
    // standalone file fetched by curl — so it is pinned against the source of
    // truth here instead.
    const legal = readFileSync(join(REPO_ROOT, "packages/subshell-protocol/src/legal.ts"), "utf8");
    const holder = /COPYRIGHT_HOLDER = "([^"]+)"/.exec(legal)?.[1];
    const year = /COPYRIGHT_YEAR = "([^"]+)"/.exec(legal)?.[1];
    expect(holder).toBeTruthy();
    expect(year).toBeTruthy();
    expect(text).toContain(`Copyright ${year} ${holder}`);
  });
});

/**
 * The public path refuses a plaintext hop; an operator override does not.
 *
 * `--location` follows redirects, so without `--proto =https` a release host
 * could bounce the download into http and the script would follow. The pin is
 * dropped when the endpoints are overridden, because an override is a
 * deliberate choice about the operator's own network — the same posture the
 * plugin registry documents for an http mirror, and what lets these tests
 * drive a local fake at all. Review, 2026-09-15.
 */
describe("transport pinning", () => {
  const script = readFileSync(SCRIPT, "utf8");

  test("pins https and a modern TLS floor for the default endpoints", () => {
    expect(script).toContain('CURL_PROTO="--proto =https --tlsv1.2"');
  });

  test("every curl on the download path honours the pin", () => {
    const curls = script.match(/curl [^\n]*/g) ?? [];
    const fetching = curls.filter((c) => c.includes("--location"));
    expect(fetching.length).toBeGreaterThan(0);
    for (const c of fetching) expect(c).toContain("$CURL_PROTO");
  });

  test("an override clears the pin, which is what lets a local fake be used", () => {
    expect(script).toContain('*) CURL_PROTO="" ;;');
  });
});
