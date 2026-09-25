import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `install-client.sh` installs the Subshell Client DESKTOP app (the app, not a
 * CLI binary — the vocabulary holds). These tests drive the real script
 * against a fake release host and PATH shims for hdiutil/cp/sudo/apt-get/id
 * (no dpkg shim — the .deb goes through the package manager, never dpkg); no
 * GitHub round trip, mirroring install-server-script.test.ts.
 *
 * What is pinned, and why each one is a defect if it regresses:
 *
 * - version truth comes from releases.json's `desktop-client` entry, never
 *   from the highest tag in the file — the manifest lists four components and
 *   a newer cli-server cut must not steer the client download;
 * - the SHA-256 sidecar is verified BEFORE anything touches the Applications
 *   directory or the package database: every refusal happens with the shim
 *   log still empty and the apps dir untouched;
 * - desktop targets are DESKTOP_TARGETS, not the CLI's three — linux-arm64 is
 *   refused by name rather than 404ing;
 * - the .deb path refuses to fabricate an install when there is no root: it
 *   prints the exact `sudo apt-get install` line instead of invoking a
 *   package manager that is not there;
 * - an existing "Subshell Client.app" is refused until SUBSHELL_CLIENT_YES=1.
 *
 * Every run sets SUBSHELL_CLIENT_APPS_DIR to a temp dir and puts PATH shims
 * first, so nothing here can reach a real /Applications, hdiutil mount, or
 * system package manager; the Linux half runs via SUBSHELL_CLIENT_TARGET so
 * both platforms exercise on any machine.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "install-client.sh");

/** Published asset names — `desktopArtifactFileName` in `@internal/subshell-protocol`. */
function dmgName(version: string): string {
  return `Subshell-Client-Desktop-${version}-darwin-arm64.dmg`;
}
function debName(version: string): string {
  return `subshell-client-desktop_${version}_amd64.deb`;
}

/** The bytes the fake host serves for any asset. The digest governs these. */
const BUNDLE_BYTES = "not-a-real-bundle-but-the-digest-governs-its-bytes\n";

/**
 * A fixture releases.json shaped exactly like the generated one
 * (`scripts/site-releases.ts`), with the other components deliberately
 * carrying HIGHER versions than the client: extraction anchored on the
 * component key is the thing being proven.
 */
function manifestFixture(opts: { schemaVersion?: number; withoutClient?: boolean } = {}): string {
  const components: Record<string, unknown> = {
    "cli-server": {
      version: "9.99.99",
      tag: "cli-server-v9.99.99",
      url: "https://github.com/subshell-ai/subshell/releases/tag/cli-server-v9.99.99",
      installScript: "install-server.sh",
    },
    "cli-node": {
      version: "8.8.8",
      tag: "cli-node-v8.8.8",
      url: "https://github.com/subshell-ai/subshell/releases/tag/cli-node-v8.8.8",
    },
    "desktop-server": {
      version: "3.1.0",
      tag: "desktop-server-v3.1.0",
      url: "https://github.com/subshell-ai/subshell/releases/tag/desktop-server-v3.1.0",
    },
  };
  if (!opts.withoutClient) {
    components["desktop-client"] = {
      version: "0.6.0",
      tag: "desktop-client-v0.6.0",
      url: "https://github.com/subshell-ai/subshell/releases/tag/desktop-client-v0.6.0",
    };
  }
  const doc = {
    schemaVersion: opts.schemaVersion ?? 1,
    generatedAt: "2026-09-23T00:00:00.000Z",
    components,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const state = {
  manifestBody: manifestFixture(),
  /** When set, served instead of the real digest of `BUNDLE_BYTES`. */
  digestOverride: null as string | null,
  /** HTTP status to answer bundle downloads with (sidecars keep answering). */
  assetStatus: 200,
  /** HTTP status to answer .sha256 sidecar fetches with. */
  sidecarStatus: 200,
  /** Pathnames the fake host was asked for, in order, across one test. */
  requests: [] as string[],
};

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url);
    state.requests.push(pathname);
    if (pathname === "/releases.json") {
      return new Response(state.manifestBody, { headers: { "content-type": "application/json" } });
    }
    if (pathname.startsWith("/download/")) {
      const name = pathname.slice("/download/".length);
      if (name.endsWith(".sha256")) {
        if (state.sidecarStatus !== 200) return new Response("no", { status: state.sidecarStatus });
        // A BARE 64-hex digest with no file name — the sidecar shape the
        // release pipeline publishes, and the reason the script pairs the
        // "<hash>  <file>" line itself.
        return new Response(`${state.digestOverride ?? sha256Hex(BUNDLE_BYTES)}\n`);
      }
      if (state.assetStatus !== 200) return new Response("no", { status: state.assetStatus });
      return new Response(BUNDLE_BYTES);
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
  state.manifestBody = manifestFixture();
  state.digestOverride = null;
  state.assetStatus = 200;
  state.sidecarStatus = 200;
  state.requests = [];
});

/**
 * A shim `hdiutil` that fakes a mount by populating the mountpoint with a
 * "Subshell Client.app". Parsing `-mountpoint` out of argv is the whole
 * trick: the script's mount command line is what is under test.
 */
const SHIM_HDIUTIL = `#!/bin/sh
printf 'hdiutil %s\\n' "$*" >> "$SUBSHELL_TEST_SHIM_LOG"
if [ "$1" = "attach" ]; then
  mp=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "-mountpoint" ]; then mp="$a"; fi
    prev="$a"
  done
  mkdir -p "$mp/Subshell Client.app/Contents/MacOS"
  printf 'stub\\n' > "$mp/Subshell Client.app/Contents/MacOS/subshell-client"
fi
exit 0
`;

/** Logs, then performs the real copy so the destination assertions are true. */
const SHIM_CP = `#!/bin/sh
printf 'cp %s\\n' "$*" >> "$SUBSHELL_TEST_SHIM_LOG"
exec /bin/cp "$@"
`;

/** Execs through: the point is to prove the script CHAINED through sudo. */
const SHIM_SUDO = `#!/bin/sh
printf 'sudo %s\\n' "$*" >> "$SUBSHELL_TEST_SHIM_LOG"
exec "$@"
`;

/**
 * Logs argv, then reports whether the .deb it was handed is present AND
 * hashes to the release's digest — that is "verified before the package
 * manager was invoked", observed from the package manager's own vantage
 * point: bytes the script had no business installing would say `no`.
 */
const SHIM_APT_GET = `#!/bin/sh
printf 'apt-get %s\\n' "$*" >> "$SUBSHELL_TEST_SHIM_LOG"
deb=""
for a in "$@"; do
  case "$a" in *.deb) deb="$a" ;; esac
done
seen=no
if [ -n "$deb" ] && [ -f "$deb" ]; then
  if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$deb" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$deb" | cut -d' ' -f1)"; fi
  if [ "$got" = "$SUBSHELL_TEST_EXPECTED_DIGEST" ]; then seen=yes; fi
fi
printf 'apt-saw-verified-deb %s\\n' "$seen" >> "$SUBSHELL_TEST_SHIM_LOG"
exit 0
`;

/** Non-root, deterministically: a root CI container must still take the sudo path. */
const SHIM_ID = `#!/bin/sh
printf 'id %s\\n' "$*" >> "$SUBSHELL_TEST_SHIM_LOG"
echo 1000
`;

/**
 * What `restrictedPath: true` symlinks into the shim dir, so the script can
 * run with PATH set to the shim dir ALONE. The list is exactly the externals
 * the Linux half of the script invokes (plus cp/uname for symmetry); the
 * whole point is that `sudo` is NOT on it, so `command -v sudo` demonstrably
 * fails rather than falling through to the host's /usr/bin/sudo.
 */
const RESTRICTED_TOOLS = [
  "curl",
  "sed",
  "grep",
  "tr",
  "mktemp",
  "rm",
  "mkdir",
  "cp",
  "id",
  "uname",
  "sha256sum",
  "shasum",
];

interface RunOpts {
  env?: Record<string, string>;
  /** PATH shims: name -> script body. Always found FIRST on PATH. */
  shims?: Record<string, string>;
  /** PATH becomes the shim dir alone — used to make sudo demonstrably absent. */
  restrictedPath?: boolean;
  /** Pre-create "$FAKE_APPS/Subshell Client.app" (with a sentinel inside). */
  preApp?: boolean;
  /** A `uname` shim so platform detection runs the same on any host. */
  unameShim?: { s: string; m: string };
  /** HOME and the apps dir sit under a path CONTAINING SPACES (quoting proof). */
  spaceyPaths?: boolean;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The temp dir the script was told is its Applications folder. */
  apps: string;
  /** Every shim invocation, in log order ("hdiutil attach ...", "cp -R ..."). */
  log: string[];
  /** Release-host pathnames requested during the run, in order. */
  requests: string[];
}

async function run(opts: RunOpts = {}): Promise<RunResult> {
  const base = mkdtempSync(join(tmpdir(), "subshell-install-client-"));
  homes.push(base);
  // With spaceyPaths, HOME itself (and so the shim dir and the apps dir under
  // it) sits inside a path with spaces — and the installed bundle is
  // "Subshell Client.app", whose name adds a SECOND space the script must
  // survive on every path it builds.
  const home = opts.spaceyPaths ? join(base, "a home with spaces") : base;
  const shimDir = join(home, "shim");
  mkdirSync(shimDir, { recursive: true });
  const apps = opts.spaceyPaths ? join(home, "Applications with spaces") : join(home, "Applications");
  mkdirSync(apps, { recursive: true });
  const appPath = join(apps, "Subshell Client.app");
  if (opts.preApp) {
    mkdirSync(join(appPath, "Contents"), { recursive: true });
    writeFileSync(join(appPath, "SENTINEL"), "the old install\n");
  }
  const logPath = join(home, "shim.log");

  const shims: Record<string, string> = { ...(opts.shims ?? {}) };
  if (opts.unameShim) {
    shims.uname = `#!/bin/sh\ncase "$1" in\n  -s) echo "${opts.unameShim.s}" ;;\n  -m) echo "${opts.unameShim.m}" ;;\nesac\n`;
  }
  for (const [name, body] of Object.entries(shims)) {
    const path = join(shimDir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  let path = `${shimDir}:${process.env.PATH ?? ""}`;
  if (opts.restrictedPath) {
    for (const tool of RESTRICTED_TOOLS) {
      if (tool in shims) continue;
      const abs = Bun.which(tool);
      if (abs !== undefined) symlinkSync(abs, join(shimDir, tool));
    }
    path = shimDir;
  }

  // Resolved by ABSOLUTE path so the child's PATH (possibly the shim dir
  // alone) can never be what finds bash.
  const proc = Bun.spawn(["/bin/bash", SCRIPT], {
    env: {
      ...process.env,
      PATH: path,
      HOME: home,
      SUBSHELL_TEST_SHIM_LOG: logPath,
      SUBSHELL_TEST_EXPECTED_DIGEST: sha256Hex(BUNDLE_BYTES),
      SUBSHELL_CLIENT_MANIFEST_URL: `${ORIGIN}/releases.json`,
      SUBSHELL_CLIENT_RELEASE_BASE: `${ORIGIN}/download`,
      SUBSHELL_CLIENT_APPS_DIR: apps,
      ...opts.env,
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
    apps,
    log: existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [],
    requests: [...state.requests],
  };
}

const APP_LOG_PREFIXES = ["hdiutil", "cp", "apt-get", "sudo"];

describe("install-client.sh", () => {
  test("case 1: the darwin happy path copies the staged app, then detaches", async () => {
    const r = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
    });
    expect(r.code).toBe(0);
    const copies = r.log.filter((l) => l.startsWith("cp "));
    expect(copies.length).toBe(1);
    expect(copies[0]).toContain("-R");
    expect(copies[0]).toContain("Subshell Client.app");
    expect(copies[0]?.trim().endsWith(`${r.apps}/`)).toBe(true);
    // The app really landed in the (fake) Applications dir: the shim cp copied.
    expect(existsSync(join(r.apps, "Subshell Client.app", "Contents", "MacOS", "subshell-client"))).toBe(true);
    // Mount and detach both happened, and the detach came after the copy —
    // copying out from under a live mount would be the defect this orders.
    const attach = r.log.findIndex((l) => l.startsWith("hdiutil attach"));
    const detach = r.log.findIndex((l) => l.startsWith("hdiutil detach"));
    const copy = r.log.findIndex((l) => l.startsWith("cp "));
    expect(attach).toBeGreaterThanOrEqual(0);
    expect(copy).toBeGreaterThan(attach);
    expect(detach).toBeGreaterThan(copy);
  });

  test("case 2: a digest mismatch installs nothing, mounts nothing, copies nothing", async () => {
    state.digestOverride = "0".repeat(64);
    const r = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("checksum mismatch");
    expect(r.stderr).toContain("nothing was installed");
    // The whole safety property, observable: no shim ran at all — no mount,
    // no copy — and the (fake) Applications dir is untouched.
    expect(r.log.filter((l) => APP_LOG_PREFIXES.some((p) => l.startsWith(`${p} `)))).toEqual([]);
    expect(existsSync(join(r.apps, "Subshell Client.app"))).toBe(false);
  });

  test("case 3: the linux happy path installs the verified .deb through sudo", async () => {
    const r = await run({
      env: { SUBSHELL_CLIENT_TARGET: "linux-x64" },
      shims: { sudo: SHIM_SUDO, "apt-get": SHIM_APT_GET, id: SHIM_ID },
    });
    expect(r.code).toBe(0);
    expect(r.log).toContain("id -u");
    expect(r.log.some((l) => l.startsWith("sudo apt-get install"))).toBe(true);
    const apt = r.log.find((l) => l.startsWith("apt-get "));
    expect(apt).toBeDefined();
    expect(apt).toContain("install -y");
    expect(apt?.trim().endsWith(`/${debName("0.6.0")}`)).toBe(true);
    // The .deb apt-get was handed exists and hashes to the release's digest:
    // the verify step ran BEFORE the package manager was invoked.
    expect(r.log).toContain("apt-saw-verified-deb yes");
  });

  test("case 4: linux without sudo refuses and prints the exact apt-get line, package manager never invoked", async () => {
    const r = await run({
      env: { SUBSHELL_CLIENT_TARGET: "linux-x64" },
      shims: { "apt-get": SHIM_APT_GET, id: SHIM_ID },
      restrictedPath: true,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("no sudo was found");
    // The escape hatch is the command itself, verbatim, .deb path included —
    // not an advice shape the operator has to reconstruct.
    expect(r.stderr).toContain("sudo apt-get install -y");
    expect(r.stderr).toContain(`${debName("0.6.0")}"`);
    expect(r.log.filter((l) => l.startsWith("apt-get "))).toEqual([]);
  });

  test("case 5: an existing app is refused by path, and replaced only under YES=1", async () => {
    const refused = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
      preApp: true,
    });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(join(refused.apps, "Subshell Client.app"));
    // Refused before the mount: the old install is byte-intact, nothing ran.
    expect(refused.log.filter((l) => APP_LOG_PREFIXES.some((p) => l.startsWith(`${p} `)))).toEqual([]);
    expect(existsSync(join(refused.apps, "Subshell Client.app", "SENTINEL"))).toBe(true);

    const replaced = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64", SUBSHELL_CLIENT_YES: "1" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
      preApp: true,
    });
    expect(replaced.code).toBe(0);
    expect(replaced.log.filter((l) => l.startsWith("cp ")).length).toBe(1);
    expect(existsSync(join(replaced.apps, "Subshell Client.app", "SENTINEL"))).toBe(false);
    expect(existsSync(join(replaced.apps, "Subshell Client.app", "Contents", "MacOS", "subshell-client"))).toBe(true);
  });

  test("case 6: resolution comes from desktop-client's manifest entry, not the highest version", async () => {
    const r = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("installing Subshell Client desktop-client-v0.6.0 (darwin-arm64)");
    expect(r.requests).toContain(`/download/${dmgName("0.6.0")}`);
    // 9.99.99 is cli-server's, and the fake host only answers under /download/
    // — but the assertion that matters is that the client script never ASKED
    // for anything carrying another component's version.
    expect(r.requests.join(" ")).not.toContain("9.99.99");

    const pinned = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64", SUBSHELL_CLIENT_VERSION: "0.5.0" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
    });
    expect(pinned.code).toBe(0);
    expect(pinned.stdout).toContain("installing Subshell Client desktop-client-v0.5.0");
    expect(pinned.stdout).not.toContain("finding the newest");
    expect(pinned.requests).toContain(`/download/${dmgName("0.5.0")}`);
  });

  test("case 7: an unpublished desktop target is refused by name, before any fetch", async () => {
    const r = await run({ env: { SUBSHELL_CLIENT_TARGET: "linux-arm64" } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unsupported target: linux-arm64");
    expect(r.stderr).toContain("Subshell Client is published for darwin-arm64, darwin-x64 and linux-x64");
    expect(r.requests).toEqual([]);
  });

  test("case 8: an unrecognized schemaVersion is refused, before any fetch past the manifest", async () => {
    state.manifestBody = manifestFixture({ schemaVersion: 2 });
    const r = await run({ env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unrecognized releases.json");
    expect(r.stderr).toContain("nothing was installed");
    expect(r.requests).toEqual(["/releases.json"]);
  });

  test("a manifest with no desktop-client entry yet refuses instead of guessing", async () => {
    state.manifestBody = manifestFixture({ withoutClient: true });
    const r = await run({ env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("lists no desktop-client release yet");
    expect(r.stderr).toContain("nothing was installed");
  });

  test("a 404 asset names the release, the target, and the two published targets", async () => {
    state.assetStatus = 404;
    const r = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("desktop-client-v0.6.0");
    expect(r.stderr).toContain(dmgName("0.6.0"));
    expect(r.stderr).toContain("darwin-arm64, darwin-x64 and linux-x64");
    expect(r.log).toEqual([]);
  });

  test("an empty or non-hex sidecar is refused by name, nothing mounts or copies", async () => {
    // Both shapes hit the SAME guard (`*[!0-9a-fA-F]*|""`): a sidecar that is
    // a bare whitespace line trims to empty just as one of junk fails the
    // hex class. Either way the digest pairing would be meaningless, so
    // NOTHING may run — the mutation shims must not have been invoked.
    state.digestOverride = "";
    const empty = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
    });
    expect(empty.code).not.toBe(0);
    expect(empty.stderr).toContain("was not a hex digest");
    expect(empty.log.filter((l) => APP_LOG_PREFIXES.some((p) => l.startsWith(`${p} `)))).toEqual([]);

    state.digestOverride = "not-a-hex-digest";
    const junk = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
    });
    expect(junk.code).not.toBe(0);
    expect(junk.stderr).toContain("was not a hex digest");
    expect(junk.log.filter((l) => APP_LOG_PREFIXES.some((p) => l.startsWith(`${p} `)))).toEqual([]);
  });

  test("a 404 sidecar is a fetch failure, not an empty digest", async () => {
    // Distinct from the case above: `--fail` must turn the non-2xx into
    // "could not fetch the checksum", so the reader learns the mirror is
    // missing the sidecar rather than that it published junk.
    state.sidecarStatus = 404;
    const r = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("could not fetch the checksum");
    expect(r.log.filter((l) => APP_LOG_PREFIXES.some((p) => l.startsWith(`${p} `)))).toEqual([]);
  });

  test("a manifest fetch failure names the manifest, before any download", async () => {
    const r = await run({
      env: {
        SUBSHELL_CLIENT_TARGET: "darwin-arm64",
        SUBSHELL_CLIENT_MANIFEST_URL: `${ORIGIN}/missing`,
      },
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("could not fetch the release manifest");
    expect(r.requests).toEqual(["/missing"]);
  });

  test("a 500 asset reports the HTTP code it got", async () => {
    // The 404 case has its own message; every OTHER non-200 must surface its
    // code rather than claim a missing bundle the release may well have.
    state.assetStatus = 500;
    const r = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("answered HTTP 500");
    expect(r.stderr).toContain("nothing was installed");
    expect(r.log).toEqual([]);
  });

  test("the darwin path survives a HOME and apps dir whose paths contain spaces", async () => {
    // Precedent: install-server-script.test.ts's HOME-with-spaces case. Here
    // it is doubly relevant — the bundle's real name is "Subshell Client.app"
    // — so every mkdir/cp/detach path carries TWO space-bearing components.
    const r = await run({
      env: { SUBSHELL_CLIENT_TARGET: "darwin-arm64" },
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
      spaceyPaths: true,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("installed Subshell Client");
    expect(existsSync(join(r.apps, "Subshell Client.app", "Contents", "MacOS", "subshell-client"))).toBe(true);
  });

  test("resolves this machine's bundle from uname when no target is set", async () => {
    const r = await run({
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
      unameShim: { s: "Darwin", m: "arm64" },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`installing Subshell Client desktop-client-v0.6.0 (darwin-arm64)`);
    expect(r.requests).toContain(`/download/${dmgName("0.6.0")}`);
  });

  test("an Intel Mac resolves to the published darwin-x64 dmg", async () => {
    const r = await run({
      shims: { hdiutil: SHIM_HDIUTIL, cp: SHIM_CP },
      unameShim: { s: "Darwin", m: "x86_64" },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("installing Subshell Client desktop-client-v0.6.0 (darwin-x64)");
    expect(r.requests).toContain("/download/Subshell-Client-Desktop-0.6.0-darwin-x64.dmg");
  });

  test("refuses any other platform by name", async () => {
    const r = await run({ unameShim: { s: "Linux", m: "ppc64le" } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Linux/ppc64le");
    expect(r.stderr).toContain("Subshell Client is published for darwin-arm64, darwin-x64 and linux-x64");
  });

  test("carries the executable bit (the one-liner is fetched raw and piped)", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});

/**
 * The public path refuses a plaintext hop; an operator override does not.
 *
 * `--location` follows redirects, so without `--proto =https` a release host
 * could bounce the download into http and the script would follow. The client
 * script decides the pin PER URL — an https fetch stays pinned no matter what
 * else is overridden, while a non-https endpoint exists only because an
 * operator (or this test fake) named it deliberately.
 */
describe("transport pinning", () => {
  const script = readFileSync(SCRIPT, "utf8");

  test("pins https and a modern TLS floor for https endpoints", () => {
    expect(script).toContain('echo "--proto =https --tlsv1.2"');
  });

  test("every curl on the download path honours the pin", () => {
    const curls = script.match(/curl [^\n]*/g) ?? [];
    const fetching = curls.filter((c) => c.includes("--location"));
    // manifest, bundle, sidecar — each carries the computed pin.
    expect(fetching.length).toBe(3);
    for (const c of fetching) expect(c).toContain("_PROTO");
  });

  test("a non-https endpoint drops the pin, which is what lets a local fake be used", () => {
    // The functional proof is every green run above: they all speak http to
    // 127.0.0.1, which only works because this arm exists.
    expect(script).toContain('*) echo "" ;;');
  });
});
