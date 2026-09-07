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
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { downloadsRoutes } from "@/api/downloads.route.js";
import { installScriptRoute } from "@/api/install-script.js";
import { APP_BASE_URL, NODE_ARTIFACTS_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
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
    // ./subshell by default, $SUBSHELL_DATA_DIR/subshell when the knob is set.
    expect(body).toContain('chmod +x "$DEST"');
    expect(body).toContain('"$DEST" enroll --server "$SERVER" --key "$KEY"');
    expect(body).toContain('start the agent with:  \\"$DEST\\" run');
    expect(body).not.toContain("exit 2");
  });

  it("install.sh SUBSHELL_DATA_DIR branch (text): set → relocated dest + umask-077 mkdir + --data-dir arg; unset → ./subshell + empty arg array", async () => {
    const body = await (await install(await mkKey())).text();
    // Env knob: `curl … | SUBSHELL_DATA_DIR=/opt/subshell bash`; UNSET keeps the
    // historical CWD install and never passes --data-dir (fix wave 1).
    expect(body).toContain('if [ -n "${SUBSHELL_DATA_DIR:-}" ]; then');
    expect(body).toContain('DATA_DIR="$SUBSHELL_DATA_DIR"');
    // Installer-created dirs are private (also on a shared /opt).
    expect(body).toContain('(umask 077; mkdir -p "$DATA_DIR")');
    expect(body).toContain('DEST="$DATA_DIR/subshell"');
    expect(body).toContain('ENROLL_DATA_DIR_ARGS=(--data-dir "$DATA_DIR")'); // real client flag (apps/node/agent/src/cli.ts)
    // Default branch: CWD binary, NO --data-dir arg, guarded against `set -u`.
    expect(body).toContain('DEST="./subshell"');
    expect(body).toContain("ENROLL_DATA_DIR_ARGS=()");
    expect(body).toContain('${ENROLL_DATA_DIR_ARGS[@]+"${ENROLL_DATA_DIR_ARGS[@]}"}');
    // One download/verify/chmod/enroll pipeline, parameterized by $DEST —
    // bytes land in a temp path and only REPLACE $DEST after the digest
    // passes, so a failed download can never clobber an installed binary.
    expect(body).toContain('--output "$TMP"');
    expect(body).toContain('mv -f "$TMP" "$DEST"');
    expect(body).not.toContain('--output "$DEST"');
    expect(body).toContain('chmod +x "$DEST"');
    expect(body).toContain('start the agent with:  \\"$DEST\\" run'); // echo names the right path
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
    "install.sh SUBSHELL_DATA_DIR branch EXECUTED (extracted block, inline bash): default → DEST=./subshell, enroll args WITHOUT --data-dir; set → relocated DEST + --data-dir + 0700 mkdir",
    async () => {
      // The rendered script contains BOTH branches, so text assertions cannot
      // show which one runs. Slice the real rendered block out of the body and
      // exec it inline (`bash -c`), reproducing the script's own enroll
      // expansion — the output IS the argv enroll would receive on each branch.
      const body = await (await install(await mkKey())).text();
      const block = body.match(/^if \[ -n "\$\{SUBSHELL_DATA_DIR:-\}" \]; then[\s\S]*?^fi$/m)?.[0];
      expect(block).toBeDefined();
      const prog = [
        "set -euo pipefail",
        block as string,
        "printf '%s\\n' DEST=\"$DEST\"",
        // The exact expansion the script's enroll line uses (pinned by the text test).
        "printf '%s\\n' enroll --server SRV --key KEY ${ENROLL_DATA_DIR_ARGS[@]+\"${ENROLL_DATA_DIR_ARGS[@]}\"}",
      ].join("\n");

      const work = mkdtempSync(join(tmpdir(), "subshell-branch-exec-"));
      try {
        function runBranch(extraEnv: Record<string, string>) {
          const env: Record<string, string> = { ...(process.env as Record<string, string>), ...extraEnv };
          // The default run must see the knob GENUINELY unset, whatever the
          // machine running the suite happens to have exported.
          if (extraEnv.SUBSHELL_DATA_DIR === undefined) delete env.SUBSHELL_DATA_DIR;
          const proc = Bun.spawnSync(["bash", "-c", prog], { cwd: work, env });
          expect(proc.stderr.toString()).toBe("");
          expect(proc.exitCode).toBe(0);
          return proc.stdout.toString().trimEnd().split("\n");
        }

        // ── default (env unset): pre-knob behavior — CWD dest, no --data-dir ──
        const def = runBranch({});
        expect(def).toContain("DEST=./subshell");
        expect(def).toContain("enroll");
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
    "install.sh EXECUTED end-to-end with stub curl/uname: default → ./subshell in CWD and enroll WITHOUT --data-dir; SUBSHELL_DATA_DIR → relocated dest + --data-dir",
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
          const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            ENROLL_LOG: logPath,
            ...extraEnv,
          };
          if (extraEnv.SUBSHELL_DATA_DIR === undefined) delete env.SUBSHELL_DATA_DIR;
          // `bash -c <body>` — exactly what `curl … | bash` hands the shell.
          const proc = Bun.spawnSync(["bash", "-c", body], { cwd, env });
          return {
            exitCode: proc.exitCode,
            stderr: proc.stderr.toString(),
            args: existsSync(logPath) ? readFileSync(logPath, "utf8").trimEnd().split("\n") : [],
          };
        }

        // ── default (env unset): the pre-knob behavior, exactly ──
        const cwd1 = join(work, "cwd-default");
        const def = runBranch(cwd1, {});
        expect(def.exitCode).toBe(0); // stderr may carry the (expected) loopback WARNING
        expect(def.args[0]).toBe("enroll");
        expect(def.args).toContain("--key");
        expect(def.args).toContain(key);
        expect(def.args).not.toContain("--data-dir"); // the whole point: the agent keeps its own default data dir
        expect(existsSync(join(cwd1, "subshell"))).toBe(true); // binary lands in the CWD
        expect(existsSync(join(cwd1, "subshell.sha256"))).toBe(false); // sidecar cleaned up

        // ── opt-in (env set): relocated dest, state follows the binary ──
        const cwd2 = join(work, "cwd-relocated");
        const dest = join(cwd2, "deep", "subshell-data"); // missing parents also pin `mkdir -p`
        const opt = runBranch(cwd2, { SUBSHELL_DATA_DIR: dest });
        expect(opt.exitCode).toBe(0);
        expect(opt.args).toContain("--data-dir");
        expect(opt.args[opt.args.indexOf("--data-dir") + 1]).toBe(dest);
        expect(existsSync(join(dest, "subshell"))).toBe(true);
        expect(existsSync(join(cwd2, "subshell"))).toBe(false); // nothing lands in the CWD
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
          // A WORKING agent already sits at $DEST — the whole contract of the
          // failure path is that it survives byte-intact.
          writeFileSync(join(cwd, "subshell"), "WORKING-BINARY\n");
          const proc = Bun.spawnSync(["bash", "-c", body], {
            cwd,
            env: {
              ...(process.env as Record<string, string>),
              PATH: `${bin}:${process.env.PATH ?? ""}`,
              FAIL_MODE: mode,
            },
          });
          return {
            cwd,
            exitCode: proc.exitCode,
            stderr: proc.stderr.toString(),
            survivor: readFileSync(join(cwd, "subshell"), "utf8"),
          };
        }

        const gone404 = runFailBranch("four-oh-four");
        expect(gone404.exitCode).toBe(1);
        expect(gone404.stderr).toContain("no linux-x64 agent binary published");
        expect(gone404.stderr).toContain("GitHub Release"); // the binary-only-host path, not just release:node
        // …and it names the ASSET to copy. That name is the artifact name, so
        // it moves whenever the artifact does.
        expect(gone404.stderr).toContain("'subshell-node-cli-linux-x64' asset");
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
