/**
 * Support machinery for `23-ssh-relay.spec.ts` (the milestone-2 crown jewel),
 * split out so the spec file carries the STORY and this one the plumbing:
 *
 *  - the ssh-agent wire spoken RAW at B's proxy socket (frame codec, roster
 *    and sign-response parsers with an INDEPENDENT reader, the ed25519
 *    signature verifier), spelled from the RFC/OpenSSH grammar rather than
 *    imported from production so the test never borrows the parser it tests;
 *  - the plane-side capture reader (the preload writes one JSON line per
 *    relay frame the broker routes; `readCapture` re-parses them);
 *  - the spec's own backend boot (port `relay`, the capture `--preload`, the
 *    staged node-artifact wrapper) and its orphan-guarded teardown.
 *
 * The `TEN_X` numbers are MEASURED facts about this fleet's OpenSSH_10.2p1
 * (identities 11 / answer 12 / sign 13 / sign-response 14; FAILURE is 5 in
 * both schemes) and are restated here on purpose: the spec asserts the
 * relay honored THAT numbering, end to end, against the real agent.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { PORTS } from "../ports";
import { shortTmuxBase } from "../stack";

const ROOT = path.join(import.meta.dirname, "..", "..");
const BACKEND_DIR = path.join(ROOT, "apps", "server", "api");
export const RELAY_ORIGIN = `http://127.0.0.1:${PORTS.relay}`;

/** Backend boot + two enrolls + the first daemon round trips, on a slow runner. */
export const READY_TIMEOUT = 90_000;
export const SPAWN_TIMEOUT = 60_000;
/** The wait for the 30 s relay lifetime cap to bite (margin over the cap). */
export const CAPTURE_TIMEOUT = 90_000;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until true or the deadline; on timeout throws the stage name. */
export async function pollUntil(
  label: string | (() => string),
  check: () => Promise<boolean> | boolean,
  timeoutMs = SPAWN_TIMEOUT,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(typeof label === "string" ? label : label());
    await sleep(300);
  }
}

/** pollUntil for a value: resolves with the first non-null producer, else throws the stage name. */
export async function pollUntilResult<T>(
  label: string,
  produce: () => Promise<T | null>,
  timeoutMs = SPAWN_TIMEOUT,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await produce();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(label);
    await sleep(250);
  }
}

export function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function modeOf(p: string): number {
  return statSync(p).mode & 0o777;
}

export function killGroup(pgid: number, sig: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    /* already gone */
  }
}

/** Kill every tmux server socket under a base dir (the spec-22 lesson: pane servers escape the daemon's group). */
export function sweepTmux(base: string): void {
  for (const uidDir of readdirSafe(base)) {
    for (const sock of readdirSafe(path.join(base, uidDir))) {
      try {
        spawnSync("tmux", ["-S", path.join(base, uidDir, sock), "kill-server"]);
      } catch {
        /* best effort */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* the ssh-agent wire, spoken RAW at B's proxy socket                  */
/* ------------------------------------------------------------------ */

/** The measured OpenSSH 10.x numbers the agent on this host speaks. */
export const TEN_X = { identities: 11, answer: 12, sign: 13, signResponse: 14 } as const;
export const AGENT_FAILURE = 5;

export function be32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

export function sshStr(s: Buffer | string): Buffer {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  return Buffer.concat([be32(b.length), b]);
}

/** One framed round trip on the agent socket: write, read exactly one reply. */
export function agentRoundTrip(sockPath: string, payload: Buffer, timeoutMs = 20_000): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const sock: Socket = createConnection(sockPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`agent round trip timed out on ${sockPath}`));
    }, timeoutMs);
    let buf = Buffer.alloc(0);
    sock.on("connect", () => sock.write(Buffer.concat([be32(payload.length), payload])));
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (buf.length >= 4 + n) {
          clearTimeout(timer);
          sock.destroy();
          resolve(Buffer.from(buf.subarray(4, 4 + n)));
        }
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export interface AnswerEntry {
  blob: Buffer;
  comment: string;
}

/** Parse an IDENTITIES_ANSWER with an INDEPENDENT reader (the test never borrows the production parser). */
export function parseIdentitiesAnswer(answer: Buffer): AnswerEntry[] {
  expect(answer[0], "IDENTITIES_ANSWER type byte (the real agent's 10.x answer)").toBe(TEN_X.answer);
  const count = answer.readUInt32BE(1);
  const entries: AnswerEntry[] = [];
  let off = 5;
  for (let i = 0; i < count; i += 1) {
    const blobLen = answer.readUInt32BE(off);
    off += 4;
    const blob = Buffer.from(answer.subarray(off, off + blobLen));
    off += blobLen;
    const cLen = answer.readUInt32BE(off);
    off += 4;
    entries.push({ blob, comment: answer.subarray(off, off + cLen).toString("utf8") });
    off += cLen;
  }
  expect(off, "IDENTITIES_ANSWER must consume exactly").toBe(answer.length);
  return entries;
}

/** The SHA256: display fingerprint, spelled exactly as OpenSSH spells it. */
export function fingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64url")}`;
}

/** An OpenSSH .pub file's decoded wire blob. */
export function pubBlob(pubPath: string): Buffer {
  const line = readFileSync(pubPath, "utf8").trim().split(" ");
  return Buffer.from(line[1] as string, "base64");
}

/** The raw 32-byte ed25519 public key out of a wire blob. */
export function ed25519Pub(blob: Buffer): Buffer {
  const len = blob.readUInt32BE(0);
  expect(blob.subarray(4, 4 + len).toString("utf8")).toBe("ssh-ed25519");
  const off = 4 + len;
  const klen = blob.readUInt32BE(off);
  return Buffer.from(blob.subarray(off + 4, off + 4 + klen));
}

/** Verify a SIGN_RESPONSE signature against A's public key over the signed data. */
export function assertValidSignature(response: Buffer, blob: Buffer, data: Buffer): void {
  expect(response[0], "SIGN_RESPONSE type byte (the real agent's 10.x response)").toBe(TEN_X.signResponse);
  let off = 1;
  const sigLen = response.readUInt32BE(off);
  off += 4;
  const sig = Buffer.from(response.subarray(off, off + sigLen)); // SSH signature blob: string algo + string raw
  let so = 0;
  const algoLen = sig.readUInt32BE(so);
  so += 4;
  expect(sig.subarray(so, so + algoLen).toString("utf8")).toBe("ssh-ed25519");
  so += algoLen;
  const rawLen = sig.readUInt32BE(so);
  so += 4;
  const raw = sig.subarray(so, so + rawLen);
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: ed25519Pub(blob).toString("base64url") },
    format: "jwk",
  });
  expect(cryptoVerify(undefined, data, key, raw), "the relayed signature must verify against A's public key").toBe(
    true,
  );
}

export function buildSignRequest(blob: Buffer, data: Buffer, withAlgorithms: boolean): Buffer {
  const parts = [Buffer.from([TEN_X.sign]), sshStr(blob), sshStr(data), be32(0)];
  if (withAlgorithms) parts.push(sshStr("ssh-ed25519"));
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ */
/* plane-side capture readers                                          */
/* ------------------------------------------------------------------ */

export interface CapturedFrame {
  kind: "frame";
  nodeId: string;
  frame: { type: "relay"; ref: string; seq: number; direction: "B2A" | "A2B"; blob: string };
}

export function readCapture(file: string): CapturedFrame[] {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: CapturedFrame[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = JSON.parse(line) as { kind: string } & Partial<CapturedFrame>;
    if (parsed.kind === "frame") out.push(parsed as CapturedFrame);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the spec's own backend, booted with the relay-capture preload       */
/* ------------------------------------------------------------------ */

export interface RelayInstance {
  child: ReturnType<typeof spawn>;
  dir: string;
  dataDir: string;
  tmuxBase: string;
  captureFile: string;
  artifactsDir: string;
}

let instance: RelayInstance | undefined;

export function stopRelayBackend(): void {
  const inst = instance;
  if (!inst) return;
  instance = undefined;
  killGroup(inst.child.pid as number, "SIGTERM");
  sweepTmux(inst.tmuxBase);
  try {
    rmSync(inst.dir, { recursive: true, force: true });
  } catch {
    /* temp roots die with /tmp; best effort like the sibling specs */
  }
}

/**
 * Boot the spec's own backend on `PORTS.relay`, preloaded with the relay
 * frame recorder, and stage `nodeArtifactWrapper` as the instance's linux-x64
 * node binary (the air-gapped plane serves its node-artifacts dir verbatim,
 * which is what the "Set up Subshell here" install fetches).
 */
export async function startRelayBackend(nodeArtifactWrapper: string): Promise<RelayInstance> {
  stopRelayBackend();
  const dir = mkdtempSync(path.join(tmpdir(), "subshell-e2e-relay-"));
  const dataDir = path.join(dir, "data");
  const artifactsDir = path.join(dir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(path.join(artifactsDir, "subshell-node-cli-linux-x64"), nodeArtifactWrapper, { mode: 0o644 });
  const tmuxBase = shortTmuxBase();
  mkdirSync(tmuxBase, { recursive: true });
  const captureFile = path.join(dir, "relay-capture.jsonl");

  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "development",
    SUBSHELL_TEST_MODE: "false",
    SUBSHELL_SERVER_CONFIG_DIR: dir,
    SERVER_PORT: String(PORTS.relay),
    HOST: "127.0.0.1",
    DATABASE_PATH: path.join(dir, "subshell.db"),
    SUBSHELL_SERVER_DATA_DIR: dataDir,
    SUBSHELL_NODE_ARTIFACTS_DIR: artifactsDir,
    APP_BASE_URL: RELAY_ORIGIN,
    BETTER_AUTH_SECRET: "e2e-secret-not-used-outside-tests-0000000000",
    SUBSHELL_PLUGIN_REGISTRY_URL: `http://127.0.0.1:${PORTS.fakeRegistry}`,
    SUBSHELL_RELEASE_URL: "", // air-gapped: only the staged wrapper is downloadable
    TMUX_TMPDIR: tmuxBase,
    E2E_RELAY_CAPTURE: captureFile,
  };
  // The plane hosts neither relay role (acceptance (d)), so its own agent and
  // ssh tier must stay irrelevant: no ambient agent, no ambient tmux nest.
  delete env.SSH_AUTH_SOCK;
  delete env.TMUX;
  delete env.TMUX_PANE;

  const child = spawn(
    "bun",
    ["run", "--preload", path.join(ROOT, "e2e", "stub", "relay-capture-preload.ts"), "src/index.ts"],
    {
      cwd: BACKEND_DIR,
      detached: true,
      stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore",
      env,
    },
  );
  child.unref();
  const inst: RelayInstance = { child, dir, dataDir, tmuxBase, captureFile, artifactsDir };
  instance = inst;

  const deadline = Date.now() + READY_TIMEOUT;
  for (;;) {
    try {
      const res = await fetch(`${RELAY_ORIGIN}/api/setup/status`);
      if (res.ok) {
        const body = (await res.json()) as { needsSetup: boolean };
        if (!body.needsSetup) throw new Error("[e2e] relay instance: port already set up (leaked run)");
        return inst;
      }
    } catch (err) {
      if ((err as Error).message.includes("port already set up")) throw err as Error;
    }
    if (Date.now() > deadline) throw new Error(`[e2e] relay instance did not become ready at ${RELAY_ORIGIN}`);
    await sleep(300);
  }
}
