import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_AGENT_VERSION, NODE_PROTOCOL_VERSION, RELEASE_MANIFEST_NAME } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { downloadsRoutes } from "@/api/downloads.route.js";
import { installScriptRoute } from "@/api/install-script.js";
import { APP_BASE_URL, NODE_ARTIFACTS_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetReleaseCacheForTests, setReleaseUrlForTests } from "@/services/releases.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

// Assembled like createApp(): the GLOBAL error handler is mounted before the
// routes, so any thrown validation would serialize as 400 INPUT_VALIDATION_ERROR
// exactly as in production. The downloads contract (unknown target → 404) is
// enforced IN-HANDLER, and these tests assert it at this level — the prod
// answer IS the tested answer.
const app = new Elysia().use(errorHandlerPlugin).use(downloadsRoutes).use(installScriptRoute);

/** `bash` is near-universal but not guaranteed; tests needing it skip without it. */
const BASH = Bun.which("bash");

/**
 * `GET /api/downloads/node/:target[.sha256]` + `GET /install.sh` (spec
 * 2026-08-31 §8). The gate is cookie session OR a valid, unconsumed setup key;
 * the closed target set is enforced in-handler before any path construction
 * (never as a params-schema throw — that would reach the global handler as a
 * 400); sha reads an on-disk sidecar when present and computes (and caches by
 * mtime) otherwise. Artifacts come from the real `NODE_ARTIFACTS_DIR` — under
 * IS_TEST that is inside this process's temp data dir, so fixtures are written
 * straight there.
 */
describe("/api/downloads + /install.sh (assembled app)", () => {
  const email = `dl-${crypto.randomUUID()}@subshell.local`;
  const pw = "downloads-1";
  const TARGET = "linux-x64";
  // Literal, not `nodeArtifactFileName(TARGET)`: the fixture is written where
  // the ROUTE will look for it, so a rename that only touched one side of that
  // contract has to fail here.
  const fixturePath = join(NODE_ARTIFACTS_DIR, `subshell-node-cli-${TARGET}`);
  const sidecarPath = `${fixturePath}.sha256`;
  const FIXTURE = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4, 0xde, 0xad, 0xbe, 0xef]);
  let expectedSha = "";
  let cookie = "";
  let userId = "";
  const repo = new NodeSetupKeysRepository(db);
  const createdKeyIds: string[] = [];

  /** GET a downloads path with optional cookie / setup-key credentials. */
  async function dl(path: string, opts: { cookie?: string; key?: string } = {}): Promise<Response> {
    const headers = new Headers();
    if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
    const q = opts.key ? `?setup_key=${encodeURIComponent(opts.key)}` : "";
    return app.fetch(new Request(`http://localhost:3080/api/downloads${path}${q}`, { headers }));
  }

  async function mkKey(ttlMs?: number): Promise<string> {
    const { row, plaintext } = await repo.create("dl-test", userId, ttlMs);
    createdKeyIds.push(row.id);
    return plaintext;
  }

  beforeAll(async () => {
    await setupAuthTables();
    mkdirSync(NODE_ARTIFACTS_DIR, { recursive: true });
    writeFileSync(fixturePath, FIXTURE);
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
    const digest = await crypto.subtle.digest("SHA-256", FIXTURE.slice().buffer);
    expectedSha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  });

  afterAll(async () => {
    rmSync(fixturePath, { force: true });
    rmSync(sidecarPath, { force: true });
    await deleteUserByEmailOrId(email);
    for (const id of createdKeyIds) await repo.deleteById(id, userId);
  });

  // ── target gating (in-handler, before any filesystem path construction) ───

  it("unknown target → 404 NOT_FOUND_ERROR at the assembled-app level, unauth and authed", async () => {
    // 404 must survive composition with the GLOBAL error handler: if the gate
    // were a t.Union params schema, the global VALIDATION branch would answer
    // 400 INPUT_VALIDATION_ERROR here instead.
    for (const res of [await dl("/node/windows-x64"), await dl("/node/windows-x64", { cookie })]) {
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string; statusCode: number };
      expect(body.code).toBe("NOT_FOUND_ERROR");
      expect(body.statusCode).toBe(404);
    }
  });

  it("path traversal in :target → 404 (gate rejects before path build)", async () => {
    // (Not `%2e%2e/x` — WHATWG URL parsing folds that into a dot-segment before
    // routing; `%252e` survives the URL layer and fails the gate.)
    for (const p of ["/node/..%2F..%2Fetc%2Fpasswd", "/node/....256", "/node/linux-x64.txt", "/node/%252e%252e"]) {
      const res = await dl(p, { cookie });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND_ERROR");
    }
  });

  it("valid target with no file on disk → 404 ApiErrorResponse", async () => {
    const res = await dl("/node/darwin-arm64", { cookie });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND_ERROR");
  });

  it("unknown .sha256 target → 404", async () => {
    expect((await dl("/node/windows-x64.sha256", { cookie })).status).toBe(404);
  });

  // ── the cookie-or-setup-key gate ──────────────────────────────────────────

  it("no cookie and no setup key → 401 ApiErrorResponse JSON on binary and sha", async () => {
    for (const path of [`/node/${TARGET}`, `/node/${TARGET}.sha256`]) {
      const res = await dl(path);
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { code: string; errId: string; statusCode: number };
      expect(typeof body.errId).toBe("string");
      expect(body.statusCode).toBe(401);
    }
  });

  it("bogus cookie and no setup key → 401 (a PRESENT cookie must be valid; key path not tried)", async () => {
    // Credential precedence: extractSessionToken sees a token, so resolveCookieSession
    // decides — a stale/forged cookie 401s even though no setup_key was offered.
    for (const path of [`/node/${TARGET}`, `/node/${TARGET}.sha256`]) {
      const res = await dl(path, { cookie: "not-a-real-subshell-token-abcdefghij" });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe("INVALID_CREDENTIALS");
    }
  });

  it("bogus setup key → 401; expired key → 401; consumed key → 401", async () => {
    expect((await dl(`/node/${TARGET}`, { key: "nsk_not_a_real_key_at_all" })).status).toBe(401);
    expect((await dl(`/node/${TARGET}`, { key: await mkKey(-60_000) })).status).toBe(401);
    const spent = await mkKey();
    await repo.consume(spent, "node-x");
    expect((await dl(`/node/${TARGET}`, { key: spent })).status).toBe(401);
  });

  it("a peek via setup key does NOT consume it (enroll must still be able to redeem)", async () => {
    const key = await mkKey();
    expect((await dl(`/node/${TARGET}`, { key })).status).toBe(200);
    expect((await dl(`/node/${TARGET}`, { key })).status).toBe(200);
    expect(await repo.peekValid(key)).toBe(true);
  });

  // ── the binary route ──────────────────────────────────────────────────────

  it("valid setup key → 200 with the fixture bytes", async () => {
    const key = await mkKey();
    const res = await dl(`/node/${TARGET}`, { key });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FIXTURE);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain(`subshell-node-cli-${TARGET}`);
  });

  it("cookie session → 200 (no setup key needed)", async () => {
    const res = await dl(`/node/${TARGET}`, { cookie });
    expect(res.status).toBe(200);
  });

  it("zero-length binary → 404 on BOTH the binary and the .sha256 route (shared empty-file rule)", async () => {
    writeFileSync(fixturePath, "");
    utimesSync(fixturePath, new Date(Date.now() + 6000), new Date(Date.now() + 6000));
    try {
      expect((await dl(`/node/${TARGET}`, { cookie })).status).toBe(404);
      expect((await dl(`/node/${TARGET}.sha256`, { cookie })).status).toBe(404);
    } finally {
      writeFileSync(fixturePath, FIXTURE);
      utimesSync(fixturePath, new Date(Date.now() + 8000), new Date(Date.now() + 8000));
    }
  });

  // ── the .sha256 routes ────────────────────────────────────────────────────

  it(".sha256 static route → 200 with the 64-hex digest of the binary", async () => {
    const res = await dl(`/node/${TARGET}.sha256`, { cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(text.trim()).toBe(expectedSha);
  });

  it(".sha256 prefers an on-disk sidecar and notices a swapped binary (mtime-keyed cache)", async () => {
    const fakeHex = "a".repeat(64);
    writeFileSync(sidecarPath, `${fakeHex}  subshell-node-cli-${TARGET}\n`);
    try {
      const side = await dl(`/node/${TARGET}.sha256`, { cookie });
      expect(side.status).toBe(200);
      expect((await side.text()).trim()).toBe(fakeHex);
    } finally {
      rmSync(sidecarPath, { force: true });
    }
    // Swap the bytes behind the same name → the computed sha must follow.
    writeFileSync(fixturePath, new Uint8Array([...FIXTURE, 0x99]));
    utimesSync(fixturePath, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    const after = await dl(`/node/${TARGET}.sha256`, { cookie });
    expect((await after.text()).trim()).not.toBe(fakeHex);
    writeFileSync(fixturePath, FIXTURE); // restore for any later assertion
    utimesSync(fixturePath, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
  });

  it(".sha256 for a known target with no binary on disk → 404", async () => {
    expect((await dl("/node/darwin-arm64.sha256", { cookie })).status).toBe(404);
  });

  // ── /install.sh ───────────────────────────────────────────────────────────

  async function install(key?: string): Promise<Response> {
    const q = key ? `?setup_key=${encodeURIComponent(key)}` : "";
    return app.fetch(new Request(`http://localhost:3080/install.sh${q}`));
  }

  it("install.sh with no key → text/plain usage script that exits 2 (never 401 JSON)", async () => {
    const res = await install();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("set -euo pipefail");
    expect(body).toContain("exit 2");
    expect(body).toContain("usage");
    expect(body).not.toContain("api/downloads"); // no download pipeline is rendered
  });

  it("install.sh with an invalid key → the same usage script, key not echoed back", async () => {
    const bogus = "nsk_definitely_not_valid_000000";
    const res = await install(bogus);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("exit 2");
    expect(body).not.toContain(bogus);
  });

  it("install.sh with shell-metacharacters in setup_key → byte-identical usage script, zero reflection", async () => {
    // Reflection would break out of the KEY="…" assignment in the real render.
    // peekValid fails first, AND renderInstallScript's own shape guard would
    // refuse — either way the answer must equal the no-key render exactly.
    const evil = `x"; echo PWNED; \`id\``;
    const body = await (await install(evil)).text();
    expect(body).toBe(await (await install()).text());
    expect(body).not.toContain("PWNED");
    expect(body).not.toContain(evil);
    expect(body).not.toContain("echo PWNED");
  });

  it("install.sh with a valid key → full pipeline; key appears ONLY in the KEY assignment", async () => {
    const key = await mkKey();
    const res = await install(key);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("set -euo pipefail");
    expect(body).toContain(`SERVER="${APP_BASE_URL}"`); // same source enroll's wsUrl derives from
    expect(body).toContain(`KEY="${key}"`);
    expect(body.split(key).length - 1).toBe(1); // exactly one literal occurrence
    // uname detection covers all four targets and fails loudly otherwise
    for (const m of ["Linux/x86_64", "Linux/aarch64", "Darwin/x86_64", "Darwin/arm64"]) {
      expect(body).toContain(m);
    }
    expect(body).toContain("linux-x64");
    expect(body).toContain("darwin-arm64");
    // download, verify (both spellings), chmod, enroll, next step
    expect(body).toContain("$SERVER/api/downloads/node/$TARGET?setup_key=$KEY");
    expect(body).toContain("$TARGET.sha256");
    expect(body).toContain("sha256sum -c");
    expect(body).toContain("shasum -a 256 -c");
    // Branch-aware spellings (fix wave 1): $DEST holds the install path —
    // $HOME/.local/bin/subshell by default, $SUBSHELL_DATA_DIR/subshell when
    // the knob is set.
    expect(body).toContain('chmod +x "$DEST"');
    // The whole sequence is ONE verb now (spec 2026-09-15 §4.5). `enroll`
    // alone left the operator with no running agent and nothing naming
    // `service install`; `setup` asks about the service and installs it.
    expect(body).toContain('"$DEST" setup --server "$SERVER" --key "$KEY"');
    expect(body).not.toContain('"$DEST" enroll --server "$SERVER"');
    // The foreground dead end is GONE: `subshell run` dies with the SSH
    // session, so the script must not end by recommending it.
    expect(body).not.toContain('"$DEST" run');
    expect(body).not.toContain("start the agent with");
    // Verify-before-chmod, still: the digest check is what makes a piped
    // install sound, and nothing may become executable ahead of it.
    expect(body.indexOf('$VERIFY "$TMP.sha256"')).toBeLessThan(body.indexOf('chmod +x "$DEST"'));
    expect(body.indexOf("$TARGET.sha256")).toBeLessThan(body.indexOf('chmod +x "$DEST"'));
    expect(body).not.toContain("exit 2");
  });

  it("install.sh checks tmux BEFORE the download, warns with the platform's command, and does not fail", async () => {
    const body = await (await install(await mkKey())).text();
    // Learning tmux is missing from a launch that fails an hour later is the
    // defect; learning it before a 70 MB download is the fix. It is a WARNING
    // because `setup` refuses properly on its own, and a download is cheap
    // next to an exit nobody can act on.
    const tmuxAt = body.indexOf("command -v tmux");
    expect(tmuxAt).toBeGreaterThan(-1);
    expect(tmuxAt).toBeLessThan(body.indexOf("==> downloading subshell"));
    expect(body).toContain("brew install tmux");
    expect(body).toContain("sudo apt-get install tmux");
    const block = body.slice(tmuxAt, body.indexOf("==> downloading subshell"));
    expect(block).not.toContain("exit 1"); // a warning, never a refusal
  });

  it("install.sh reattaches /dev/tty so a piped install can answer setup's question", async () => {
    const body = await (await install(await mkKey())).text();
    // `curl … | bash` leaves stdin on a pipe that is already at EOF, so the
    // service question would silently take its default with nobody able to
    // say otherwise. The guard matters as much as the exec: a CI pipe has no
    // /dev/tty, and under `set -e` an `&&` chain whose first test fails would
    // abort the whole install — hence the `if` form.
    expect(body).toContain("exec </dev/tty");
    expect(body).toContain("if [ -t 1 ] && [ -r /dev/tty ]; then");
    expect(body.indexOf("exec </dev/tty")).toBeLessThan(body.indexOf('"$DEST" setup'));
  });

  it("install.sh forwards SUBSHELL_NO_SERVICE as --no-service, and passes nothing when it is unset", async () => {
    const body = await (await install(await mkKey())).text();
    // EXACTLY "1", never merely non-empty: install-server.sh reads it the same
    // way and the same operator runs both one-liners, so `=0` must not skip the
    // service here while installing one there. Mirrors the server script's own
    // "only counts as the exact opt-in" test (found in review, 2026-09-15).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an asserted script, not a JS template
    expect(body).toContain('if [ "${SUBSHELL_NO_SERVICE:-}" = "1" ]; then');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an asserted script, not a JS template
    expect(body).not.toContain('if [ -n "${SUBSHELL_NO_SERVICE:-}" ]; then');
    expect(body).toContain("SETUP_SERVICE_ARGS=(--no-service)");
    expect(body).toContain("SETUP_SERVICE_ARGS=()");
    // Guarded expansion, same `set -u` / bash 3.2 reason as the data-dir array.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an asserted script, not a JS template
    expect(body).toContain('${SETUP_SERVICE_ARGS[@]+"${SETUP_SERVICE_ARGS[@]}"}');
  });

  it("install.sh installs to ~/.local/bin and warns when that is off PATH", async () => {
    const body = await (await install(await mkKey())).text();
    // The CWD of a one-off curl is not a stable home for a binary a service
    // definition will later name by absolute path — and it is the same path
    // Subshell Client writes, so the two installs agree.
    expect(body).toContain('BIN_DIR="$HOME/.local/bin"');
    expect(body).toContain('mkdir -p "$BIN_DIR"');
    expect(body).toContain('DEST="$BIN_DIR/subshell"');
    expect(body).not.toContain('DEST="./subshell"');
    expect(body).toContain('case ":$PATH:" in');
    expect(body).toContain("is not on your PATH");
    expect(body).toContain("export PATH=");
  });

  it("install.sh SUBSHELL_DATA_DIR branch (text): set → relocated dest + umask-077 mkdir + --data-dir arg; unset → ~/.local/bin + empty arg array", async () => {
    const body = await (await install(await mkKey())).text();
    // Env knob: `curl … | SUBSHELL_DATA_DIR=/opt/subshell bash`; UNSET installs
    // to ~/.local/bin and never passes --data-dir (the agent keeps its own).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an asserted script, not a JS template
    expect(body).toContain('if [ -n "${SUBSHELL_DATA_DIR:-}" ]; then');
    expect(body).toContain('DATA_DIR="$SUBSHELL_DATA_DIR"');
    // Installer-created dirs are private (also on a shared /opt).
    expect(body).toContain('(umask 077; mkdir -p "$DATA_DIR")');
    expect(body).toContain('BIN_DIR="$DATA_DIR"');
    expect(body).toContain('SETUP_DATA_DIR_ARGS=(--data-dir "$DATA_DIR")'); // real agent flag (apps/node/agent/src/cli.ts)
    // Default branch: ~/.local/bin, NO --data-dir arg, guarded against `set -u`.
    expect(body).toContain('BIN_DIR="$HOME/.local/bin"');
    expect(body).toContain("SETUP_DATA_DIR_ARGS=()");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an asserted script, not a JS template
    expect(body).toContain('${SETUP_DATA_DIR_ARGS[@]+"${SETUP_DATA_DIR_ARGS[@]}"}');
    // One download/verify/chmod/enroll pipeline, parameterized by $DEST —
    // bytes land in a temp path and only REPLACE $DEST after the digest
    // passes, so a failed download can never clobber an installed binary.
    expect(body).toContain('--output "$TMP"');
    expect(body).toContain('mv -f "$TMP" "$DEST"');
    expect(body).not.toContain('--output "$DEST"');
    expect(body).toContain('chmod +x "$DEST"');
    expect(body).toContain('"$DEST" setup --server "$SERVER"'); // the one verb, parameterized by $DEST
  });

  /**
   * Some sandboxes silently no-op SCRIPT-FILE execution (`bash ./file` exits 0
   * without running it) — then the stubbed "subshell" binary never runs and
   * the full-pipeline test proves nothing. Probe once; skip that test where
   * file exec does not verifiably work.
   */
  const FILE_EXEC = (() => {
    if (!BASH) return false;
    const dir = mkdtempSync(join(tmpdir(), "subshell-exec-probe-"));
    try {
      const probe = join(dir, "probe.sh");
      writeFileSync(probe, "#!/usr/bin/env bash\necho SUBSHELL_EXEC_PROBE\n");
      chmodSync(probe, 0o755);
      return Bun.spawnSync(["bash", probe]).stdout.toString().includes("SUBSHELL_EXEC_PROBE");
    } catch {
      return false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();

  it.skipIf(!BASH)(
    "install.sh SUBSHELL_DATA_DIR branch EXECUTED (extracted block, inline bash): default → DEST=$HOME/.local/bin/subshell, setup args WITHOUT --data-dir; set → relocated DEST + --data-dir + 0700 mkdir",
    async () => {
      // The rendered script contains BOTH branches, so text assertions cannot
      // show which one runs. Slice the real rendered block out of the body and
      // exec it inline (`bash -c`), reproducing the script's own enroll
      // expansion — the output IS the argv enroll would receive on each branch.
      const body = await (await install(await mkKey())).text();
      // The block now ends at the DEST assignment that follows both arms —
      // BIN_DIR is what the branch picks, and $DEST is derived from it once.
      const block = body.match(
        /^if \[ -n "\$\{SUBSHELL_DATA_DIR:-\}" \]; then[\s\S]*?^DEST="\$BIN_DIR\/subshell"$/m,
      )?.[0];
      expect(block).toBeDefined();
      const prog = [
        "set -euo pipefail",
        block as string,
        "printf '%s\\n' DEST=\"$DEST\"",
        // The exact expansion the script's setup line uses (pinned by the text test).
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an asserted script, not a JS template
        "printf '%s\\n' setup --server SRV --key KEY ${SETUP_DATA_DIR_ARGS[@]+\"${SETUP_DATA_DIR_ARGS[@]}\"}",
      ].join("\n");

      const work = mkdtempSync(join(tmpdir(), "subshell-branch-exec-"));
      try {
        function runBranch(extraEnv: Record<string, string>) {
          // HOME is REDIRECTED into the temp tree: the default branch now
          // mkdir -p's $HOME/.local/bin, and a test suite must never write
          // into the developer's real home.
          const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            HOME: join(work, "home"),
            ...extraEnv,
          };
          // The default run must see the knob GENUINELY unset, whatever the
          // machine running the suite happens to have exported.
          if (extraEnv.SUBSHELL_DATA_DIR === undefined) delete env.SUBSHELL_DATA_DIR;
          const proc = Bun.spawnSync(["bash", "-c", prog], { cwd: work, env });
          expect(proc.stderr.toString()).toBe("");
          expect(proc.exitCode).toBe(0);
          return proc.stdout.toString().trimEnd().split("\n");
        }

        // ── default (env unset): ~/.local/bin dest, no --data-dir ──
        const def = runBranch({});
        expect(def).toContain(`DEST=${join(work, "home", ".local", "bin")}/subshell`);
        expect(def).toContain("setup");
        expect(def).not.toContain("--data-dir"); // the agent keeps its own default data dir

        // ── opt-in (env set): relocated dest, state follows the binary ──
        const dest = join(work, "deep", "subshell-data"); // missing parents also pin `mkdir -p`
        const opt = runBranch({ SUBSHELL_DATA_DIR: dest });
        expect(opt).toContain(`DEST=${dest}/subshell`);
        expect(opt).toContain("--data-dir");
        expect(opt[opt.indexOf("--data-dir") + 1]).toBe(dest);
        expect(statSync(dest).mode & 0o777).toBe(0o700); // umask-077 mkdir
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  const HASH_TOOL = Bun.which("sha256sum") ?? Bun.which("shasum");

  it.skipIf(!BASH || !HASH_TOOL || !FILE_EXEC)(
    "install.sh EXECUTED end-to-end with stub curl/uname: default → ~/.local/bin/subshell and setup WITHOUT --data-dir; SUBSHELL_DATA_DIR → relocated dest + --data-dir; SUBSHELL_NO_SERVICE → --no-service",
    async () => {
      const key = await mkKey();
      const body = await (await install(key)).text();

      // Full-pipeline twin of the branch test above: stub `curl` serves a fake
      // agent that logs its argv (and the digest its stub verifier accepts), so
      // the assertions read what enroll ACTUALLY RECEIVED through the real
      // download → verify → chmod → enroll chain.
      const work = mkdtempSync(join(tmpdir(), "subshell-install-exec-"));
      try {
        const bin = join(work, "bin");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "curl"),
          [
            "#!/usr/bin/env bash",
            'out=""',
            'prev=""',
            'for a in "$@"; do',
            '  [ "$prev" = "--output" ] && out="$a"',
            '  prev="$a"',
            "done",
            'if [ -n "$out" ]; then',
            '  printf \'%s\\n\' \'#!/usr/bin/env bash\' \'for a in "$@"; do printf "%s\\n" "$a" >> "$ENROLL_LOG"; done\' > "$out"',
            "  printf 200", // the binary leg reads the HTTP code off stdout
            "else",
            "  printf '%s\\n' \"$(printf '0%.0s' $(seq 1 64))\"", // 64 zeros; the verifier is stubbed too
            "fi",
            "",
          ].join("\n"),
        );
        writeFileSync(
          join(bin, "uname"),
          '#!/usr/bin/env bash\ncase "$1" in\n  -s) echo Linux ;;\n  -m) echo x86_64 ;;\nesac\n',
        );
        for (const tool of ["sha256sum", "shasum"]) writeFileSync(join(bin, tool), "#!/usr/bin/env bash\nexit 0\n");
        for (const tool of ["curl", "uname", "sha256sum", "shasum"]) chmodSync(join(bin, tool), 0o755);

        function runBranch(cwd: string, extraEnv: Record<string, string>) {
          mkdirSync(cwd, { recursive: true });
          const logPath = join(work, `enroll-${cwd.split("/").pop()}.log`);
          // Every run gets its OWN throwaway HOME: the default branch installs
          // into $HOME/.local/bin, and a suite that wrote into the developer's
          // real home would be a genuine install nobody asked for.
          const home = join(work, `home-${cwd.split("/").pop()}`);
          const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            HOME: home,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            ENROLL_LOG: logPath,
            ...extraEnv,
          };
          if (extraEnv.SUBSHELL_DATA_DIR === undefined) delete env.SUBSHELL_DATA_DIR;
          if (extraEnv.SUBSHELL_NO_SERVICE === undefined) delete env.SUBSHELL_NO_SERVICE;
          // `bash -c <body>` — exactly what `curl … | bash` hands the shell.
          const proc = Bun.spawnSync(["bash", "-c", body], { cwd, env });
          return {
            home,
            exitCode: proc.exitCode,
            stderr: proc.stderr.toString(),
            args: existsSync(logPath) ? readFileSync(logPath, "utf8").trimEnd().split("\n") : [],
          };
        }

        // ── default (env unset): ~/.local/bin, one `setup` verb, no --data-dir ──
        const cwd1 = join(work, "cwd-default");
        const def = runBranch(cwd1, {});
        expect(def.exitCode).toBe(0); // stderr may carry the (expected) loopback WARNING
        expect(def.args[0]).toBe("setup"); // NOT enroll: the sequence is one verb
        expect(def.args).toContain("--key");
        expect(def.args).toContain(key);
        expect(def.args).not.toContain("--data-dir"); // the whole point: the agent keeps its own default data dir
        expect(def.args).not.toContain("--no-service"); // unset knob forwards nothing
        expect(existsSync(join(def.home, ".local", "bin", "subshell"))).toBe(true); // a stable path, not the curl's CWD
        expect(existsSync(join(cwd1, "subshell"))).toBe(false);
        expect(existsSync(join(def.home, ".local", "bin", "subshell.sha256"))).toBe(false); // sidecar cleaned up

        // ── opt-in (env set): relocated dest, state follows the binary ──
        const cwd2 = join(work, "cwd-relocated");
        const dest = join(cwd2, "deep", "subshell-data"); // missing parents also pin `mkdir -p`
        const opt = runBranch(cwd2, { SUBSHELL_DATA_DIR: dest });
        expect(opt.exitCode).toBe(0);
        expect(opt.args).toContain("--data-dir");
        expect(opt.args[opt.args.indexOf("--data-dir") + 1]).toBe(dest);
        expect(existsSync(join(dest, "subshell"))).toBe(true);
        expect(existsSync(join(cwd2, "subshell"))).toBe(false); // nothing lands in the CWD

        // ── SUBSHELL_NO_SERVICE: the scripted opt-out reaches the verb ──
        const cwd3 = join(work, "cwd-no-service");
        const noSvc = runBranch(cwd3, { SUBSHELL_NO_SERVICE: "1" });
        expect(noSvc.exitCode).toBe(0);
        expect(noSvc.args[0]).toBe("setup");
        expect(noSvc.args).toContain("--no-service");

        // ── and `=0` is NOT the opt-out ──
        // It used to be, because the test was `-n`: any non-empty value
        // skipped the service here while install-server.sh, which requires
        // exactly "1", installed one. The same operator runs both one-liners.
        const zero = runBranch(join(work, "cwd-no-service-0"), { SUBSHELL_NO_SERVICE: "0" });
        expect(zero.exitCode).toBe(0);
        expect(zero.args).not.toContain("--no-service");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!BASH || !FILE_EXEC)(
    "install.sh EXECUTED against a failing server: 404/network/mismatch arms advise, exit 1, and leave a pre-existing agent byte-intact",
    async () => {
      // The review-fixture for the guard the first fix shipped WITHOUT: curl
      // --fail leaves an existing output file intact, so a failed download
      // must NEVER touch an already-installed $DEST — and each failure class
      // needs its OWN advice (404 = publish artifacts, 401-class dead keys
      // and plain network errors do not; the first guard conflated them).
      const key = await mkKey();
      const body = await (await install(key)).text();
      const work = mkdtempSync(join(tmpdir(), "subshell-install-fail-"));
      try {
        const bin = join(work, "bin");
        mkdirSync(bin);
        // FAIL_MODE picks the arm. Binary vs digest leg is told apart by
        // --output. In `corrupt` the REAL sha256sum (no stub here) must
        // reject the mismatching sidecar the stub serves.
        writeFileSync(
          join(bin, "curl"),
          [
            "#!/usr/bin/env bash",
            'out=""; prev=""; for a in "$@"; do [ "$prev" = "--output" ] && out="$a"; prev="$a"; done',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an asserted script, not a JS template
            'case "${FAIL_MODE:-ok}" in',
            "  net) exit 7 ;;",
            '  four-oh-four) [ -n "$out" ] && printf "no such artifact" > "$out"; printf 404; exit 0 ;;',
            '  corrupt) if [ -n "$out" ]; then printf "definitely-not-a-binary" > "$out"; printf 200; else printf \'%s\\n\' "$(printf \'f%.0s\' $(seq 1 64))"; fi; exit 0 ;;',
            "esac",
            'if [ -n "$out" ]; then printf "x" > "$out"; printf 200; else printf \'%s\\n\' "$(printf \'0%.0s\' $(seq 1 64))"; fi',
          ].join("\n"),
        );
        writeFileSync(
          join(bin, "uname"),
          '#!/usr/bin/env bash\ncase "$1" in\n  -s) echo Linux ;;\n  -m) echo x86_64 ;;\nesac\n',
        );
        chmodSync(join(bin, "curl"), 0o755);
        chmodSync(join(bin, "uname"), 0o755);

        function runFailBranch(mode: string) {
          const cwd = join(work, `cwd-${mode}`);
          mkdirSync(cwd, { recursive: true });
          // $DEST is ~/.local/bin/subshell now, so the pre-existing agent goes
          // there — under a throwaway HOME, never the developer's own.
          const home = join(work, `home-${mode}`);
          const destDir = join(home, ".local", "bin");
          mkdirSync(destDir, { recursive: true });
          // A WORKING agent already sits at $DEST — the whole contract of the
          // failure path is that it survives byte-intact.
          writeFileSync(join(destDir, "subshell"), "WORKING-BINARY\n");
          const proc = Bun.spawnSync(["bash", "-c", body], {
            cwd,
            env: {
              ...(process.env as Record<string, string>),
              HOME: home,
              PATH: `${bin}:${process.env.PATH ?? ""}`,
              FAIL_MODE: mode,
            },
          });
          return {
            cwd: destDir,
            exitCode: proc.exitCode,
            stderr: proc.stderr.toString(),
            survivor: readFileSync(join(destDir, "subshell"), "utf8"),
          };
        }

        const gone404 = runFailBranch("four-oh-four");
        expect(gone404.exitCode).toBe(1);
        // The 404 arm no longer means "nobody published it": the server also
        // reaches for the project's release, so the message leads with what
        // the operator can check (the server could not provide one, and why)
        // and keeps the hand-publish route as the fallback.
        expect(gone404.stderr).toContain("could not provide a linux-x64 agent binary");
        expect(gone404.stderr).toContain("SUBSHELL_RELEASE_URL");
        expect(gone404.stderr).toContain("subshell-node-cli-linux-x64");
        expect(gone404.stderr).toContain("GitHub Release"); // the binary-only-host path, not just release:node
        // …and it names the ASSET to copy. That name is the artifact name, so
        // it moves whenever the artifact does.
        expect(gone404.stderr).toContain("'subshell-node-cli-linux-x64' asset");
        // …and the hand-install fallback names the SAME verb the script runs,
        // so the two paths cannot recommend different things.
        expect(gone404.stderr).toContain("subshell setup --server");
        expect(gone404.survivor).toBe("WORKING-BINARY\n");
        expect(existsSync(join(gone404.cwd, "subshell.part"))).toBe(false); // temp cleaned

        const net = runFailBranch("net");
        expect(net.exitCode).toBe(1);
        expect(net.stderr).toContain("could not reach");
        expect(net.stderr).not.toContain("published"); // a dead line is NOT a publishing problem
        expect(net.survivor).toBe("WORKING-BINARY\n");

        if (Bun.which("sha256sum")) {
          const corrupt = runFailBranch("corrupt");
          expect(corrupt.exitCode).toBe(1);
          expect(corrupt.stderr).toContain("checksum mismatch");
          expect(corrupt.survivor).toBe("WORKING-BINARY\n");
          expect(existsSync(join(corrupt.cwd, "subshell.part"))).toBe(false);
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it("install.sh carries a runtime loopback guard and the non-root note as script text", async () => {
    // The RUNTIME conditional is pinned here (uname/the dialer are only known
    // on the target) — and the `[::1]` arm must be QUOTED in the case pattern,
    // else it is a character class that matches no real IPv6 literal.
    const body = await (await install(await mkKey())).text();
    expect(body).toContain('case "$SERVER" in');
    expect(body).toContain('*://localhost*|*://127.*|*"://[::1]"*');
    expect(body).toMatch(/localhost[\s\S]*VPN\/LAN/); // the branch echoes the warning
    expect(body).toContain("runs as the invoking user; no sudo needed");
    // The usage render (no key) has no pipeline to guard.
    expect(await (await install()).text()).not.toContain("SUBSHELL_DATA_DIR");
  });

  it.skipIf(!BASH)("both install.sh renders pass `bash -n` (syntax gate for future template edits)", async () => {
    const usage = await (await install()).text();
    const full = await (await install(await mkKey())).text();
    for (const body of [usage, full]) {
      expect(body.startsWith("#!/usr/bin/env bash")).toBe(true);
      const proc = Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(body) });
      expect(proc.stderr.toString()).toBe("");
      expect(proc.exitCode).toBe(0);
    }
  });
});

/**
 * The lazy fetch (spec 2026-09-12): a target with nothing on disk is
 * downloaded from the project's own release the first time a machine asks,
 * rather than 404ing until an operator publishes it by hand.
 *
 * Under IS_TEST the release source is EMPTY by default, so every case above
 * exercises the air-gapped behaviour and none of them reaches the network.
 * These opt in, against a fake release server.
 */
describe("/api/downloads/node/* — the lazy fetch", () => {
  const email = `dlfetch-${crypto.randomUUID()}@subshell.local`;
  const pw = "downloads-2";
  const TARGET = "darwin-arm64";
  const binaryPath = join(NODE_ARTIFACTS_DIR, `subshell-node-cli-${TARGET}`);
  const BODY = "a convincing darwin binary";
  let cookie = "";
  let _userId = "";
  let release: { url: string; stop: () => void; serveDigest: string };

  beforeAll(async () => {
    await setupAuthTables();
    mkdirSync(NODE_ARTIFACTS_DIR, { recursive: true });
    _userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(new TextEncoder().encode(BODY));
    const digest = hasher.digest("hex");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const base = `http://127.0.0.1:${server.port}`;
        if (url.pathname === "/releases") {
          return Response.json([
            {
              tag_name: "node-v9.9.9",
              draft: false,
              assets: [
                { name: `subshell-node-cli-${TARGET}`, browser_download_url: `${base}/bin` },
                { name: `subshell-node-cli-${TARGET}.sha256`, browser_download_url: `${base}/sha` },
                // The fifth asset (spec 2026-09-15 §3.2). Without it the plane
                // cannot tell which protocol that agent speaks and refuses to
                // offer the release at all — so a fake release that omits it
                // is testing the refusal, not the fetch.
                { name: RELEASE_MANIFEST_NAME, browser_download_url: `${base}/manifest` },
              ],
            },
          ]);
        }
        if (url.pathname === "/bin") return new Response(BODY);
        if (url.pathname === "/sha") return new Response(`${release.serveDigest}\n`);
        if (url.pathname === "/manifest") {
          return Response.json({
            component: "node",
            version: "9.9.9",
            nodeProtocol: NODE_PROTOCOL_VERSION,
            minAgentVersion: MIN_AGENT_VERSION,
            commit: "0123456789abcdef0123456789abcdef01234567",
          });
        }
        return new Response("no", { status: 404 });
      },
    });
    release = { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), serveDigest: digest };
  });

  afterAll(async () => {
    release.stop();
    setReleaseUrlForTests(null);
    resetReleaseCacheForTests();
    rmSync(binaryPath, { force: true });
    rmSync(`${binaryPath}.sha256`, { force: true });
    rmSync(join(NODE_ARTIFACTS_DIR, ".fetched.json"), { force: true });
    await deleteUserByEmailOrId(email);
  });

  it("serves a target that is on NO disk by fetching it, and caches it", async () => {
    setReleaseUrlForTests(`${release.url}/releases`);
    resetReleaseCacheForTests();
    expect(existsSync(binaryPath)).toBe(false);

    const res = await app.handle(
      new Request(`http://localhost/api/downloads/node/${TARGET}`, {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
    // Cached, so the next machine of this platform is served from disk.
    expect(readFileSync(binaryPath, "utf8")).toBe(BODY);

    // And the sha route is now answered locally, from the sidecar the fetch wrote.
    const sha = await app.handle(
      new Request(`http://localhost/api/downloads/node/${TARGET}.sha256`, {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
    expect(sha.status).toBe(200);
    expect((await sha.text()).trim()).toBe(release.serveDigest);
  });

  it("404s rather than 500s when the release cannot be read", async () => {
    rmSync(binaryPath, { force: true });
    rmSync(join(NODE_ARTIFACTS_DIR, ".fetched.json"), { force: true });
    // A closed port: the same OUTCOME as an unpublished build (this machine
    // cannot install), so it must be the same status — `install.sh` has a 404
    // arm and no branch for a 502.
    setReleaseUrlForTests("http://127.0.0.1:1/releases");
    resetReleaseCacheForTests();
    const res = await app.handle(
      new Request(`http://localhost/api/downloads/node/${TARGET}`, {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("still requires a credential — a fetch is not a way around the gate", async () => {
    setReleaseUrlForTests(`${release.url}/releases`);
    resetReleaseCacheForTests();
    const res = await app.handle(new Request(`http://localhost/api/downloads/node/${TARGET}`));
    expect(res.status).toBe(401);
  });
});
