import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNodeSshAgentIdentities, parseNodeSshIdentity } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { execSshAgentIdentities } from "../commands/ssh-identity.js";
import { loadOrCreateIdentity, signingIdentityPath } from "../identity.js";
import { type AgentScheme, CLASSIC_SCHEME, OPENSSH_10X_SCHEME } from "../relay-agent-scheme.js";
import { writeSshEnabled } from "../ssh-enabled.js";

/**
 * `ssh_register_identity` (spec 2026-10-08 §4.3): the machine answers its
 * SIGNING PUBLIC JWK and nothing else. Driven through `dispatchCommand`
 * exactly as the daemon drives it (the commands-ssh.test.ts posture).
 *
 * What this file owns:
 * - the answer IS `identity.signingPublicJwk`, byte for byte, stable across
 *   asks (a re-report after rotation must not read as a mismatch);
 * - the private half NEVER rides out: no `d` in the answer's JWK, and the
 *   serialized result never contains the stored private JWK;
 * - NO ssh-enabled gate: registration is the machine's own act, not an SSH
 *   act, and a pre-M2 node hits it while its mirror still says off;
 * - a corrupt signing file fails closed through dispatch's whole-switch wrap
 *   (identity.ts quarantines and throws; the plane learns `ok:false`).
 */

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-cmds-ssh-id-")));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function makeCtx(dataDir: string): CommandContext {
  return { config: { dataDir } } as unknown as CommandContext;
}

function freshDir(tag: string): string {
  const dir = join(base, tag, "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("ssh_register_identity", () => {
  it("answers the signing PUBLIC jwk byte-for-byte, stable across asks", async () => {
    const dir = freshDir("basic");
    const identity = await loadOrCreateIdentity(dir);
    const first = await dispatchCommand(makeCtx(dir), { type: "ssh_register_identity" });
    expect(first.ok).toBe(true);
    const parsed = parseNodeSshIdentity(first.ok ? first.data : null);
    expect(parsed?.signingPublicKey).toBe(identity.signingPublicJwk);
    // The §4.3 guard compares BYTES: a second ask must answer the same string.
    const second = await dispatchCommand(makeCtx(dir), { type: "ssh_register_identity" });
    expect(second.ok && second.data).toEqual(first.ok ? first.data : null);
  });

  it("the private half never leaves: no d member in the answer, no private jwk in the frame", async () => {
    const dir = freshDir("private");
    const identity = await loadOrCreateIdentity(dir);
    const result = await dispatchCommand(makeCtx(dir), { type: "ssh_register_identity" });
    expect(result.ok).toBe(true);
    const answer = parseNodeSshIdentity(result.ok ? result.data : null);
    if (!answer) throw new Error("identity answer did not validate");
    const jwk = JSON.parse(answer.signingPublicKey) as Record<string, unknown>;
    expect("d" in jwk).toBe(false);
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    // The whole wire frame, serialized, must not carry the stored private JWK.
    expect(JSON.stringify(result)).not.toContain(identity.signingPrivateJwk);
  });

  it("ignores the ssh-enabled gate: an un-mirrored (fail-closed OFF) machine still registers", async () => {
    // Deliberately NO ssh-enabled.json here: the mirror is absent, which the
    // gate reads as OFF. Registration precedes the gate; a node that never
    // turned SSH on must still be able to file its identity (§4.3).
    const dir = freshDir("gate-off");
    expect(readdirSync(dir).length).toBe(0);
    const result = await dispatchCommand(makeCtx(dir), { type: "ssh_register_identity" });
    expect(result.ok).toBe(true);
    // The pair the loader minted on this ask is exactly what the answer names.
    const identity = await loadOrCreateIdentity(dir);
    const parsed = parseNodeSshIdentity(result.ok ? result.data : null);
    expect(parsed?.signingPublicKey).toBe(identity.signingPublicJwk);
  });

  it("a corrupt signing file fails closed: quarantine throw surfaces as ok:false", async () => {
    const dir = freshDir("corrupt");
    writeFileSync(signingIdentityPath(dir), "not a keypair", { mode: 0o600 });
    // The handler may create the encryption pair, but the signing pair's
    // quarantine throw must reach dispatch's whole-switch wrap as a refusal.
    const result = await dispatchCommand(makeCtx(dir), { type: "ssh_register_identity" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("refusing to overwrite existing key material");
    // The corrupt file was moved aside, not answered over.
    const quarantined = readdirSync(dir).filter((f) => f.includes("corrupt-"));
    expect(quarantined.length).toBe(1);
    expect(readdirSync(dir)).not.toContain("node-signing-identity.json");
  });
});

/* ------------------------------------------------------------------ */
/* ssh_agent_identities (spec 2026-10-08 §5.4, Task 11)                */
/* ------------------------------------------------------------------ */

/**
 * The roster command: probe A's agent scheme, ask the identities request,
 * and answer `{ identities: [{ fingerprint, comment }] }` with the blobs
 * WITHHELD. Driven with a scripted requestAgent (the relay-agent-scheme
 * test's fixture posture): the probe is real (candidate order and
 * positive-confirmation are what the 2026-10-08 ruling pins), only the
 * socket is a stand-in.
 */

const GATE_STAMP = "2026-10-08T10:00:00.000Z";

function be32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function sshStr(bytes: Buffer | string): Buffer {
  const b = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return Buffer.concat([be32(b.length), b]);
}

/** Independent oracle: SHA-256 over the wire blob, base64url (never the production helper). */
function fp(wire: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(wire).digest("base64url")}`;
}

const KEY_LAPTOP = Buffer.concat([sshStr("ssh-ed25519"), sshStr(Buffer.from("LAPTOP-BLOB"))]);
const KEY_BACKUP = Buffer.concat([sshStr("ssh-rsa"), sshStr(Buffer.from("BACKUP-BLOB"))]);

function identitiesAnswer(scheme: AgentScheme, entries: { blob: Buffer; comment: string }[]): Buffer {
  return Buffer.concat([
    Buffer.from([scheme.answer]),
    be32(entries.length),
    ...entries.flatMap((e) => [sshStr(e.blob), sshStr(e.comment)]),
  ]);
}

const ROSTER = [
  { blob: KEY_LAPTOP, comment: "laptop key" },
  { blob: KEY_BACKUP, comment: "backup key" },
];

/** A scripted agent: records every payload, answers per the script. */
function scriptedAgent(script: (payload: Buffer) => Buffer): {
  sent: Buffer[];
  requestAgent: (path: string, payload: Buffer) => Promise<Buffer>;
} {
  const sent: Buffer[] = [];
  return {
    sent,
    requestAgent: async (_path: string, payload: Buffer): Promise<Buffer> => {
      sent.push(Buffer.from(payload));
      return script(payload);
    },
  };
}

/** Gate-ON context in a fresh dir (the mirror written by its own writer). */
function gatedDir(tag: string): string {
  const dir = join(base, `${tag}-gated`, "data");
  mkdirSync(dir, { recursive: true });
  writeSshEnabled(dir, { on: true, changedAt: GATE_STAMP });
  return dir;
}

describe("ssh_agent_identities", () => {
  it("answers the roster as fingerprints + comments in BOTH schemes, and the blob bytes never ride out", async () => {
    for (const [scheme, probeScript] of [
      // A 10.x agent: the classic candidate answers FAILURE(5), byte 11 resolves 10.x.
      [
        OPENSSH_10X_SCHEME,
        (p: Buffer): Buffer | null =>
          p.equals(Buffer.from([13])) ? Buffer.from([5]) : identitiesAnswer(OPENSSH_10X_SCHEME, ROSTER),
      ],
      // A classic agent resolves on the FIRST probe, no second round trip.
      [
        CLASSIC_SCHEME,
        (p: Buffer): Buffer | null => (p.equals(Buffer.from([13])) ? identitiesAnswer(CLASSIC_SCHEME, ROSTER) : null),
      ],
    ] as const) {
      const agent = scriptedAgent((p) => {
        const a = probeScript(p);
        if (a === null) throw new Error(`unexpected roster request byte ${p[0]} for ${scheme.name}`);
        return a;
      });
      const result = await execSshAgentIdentities(makeCtx(gatedDir(scheme.name)), {
        resolveAgentSocket: () => "/fake/agent.sock",
        requestAgent: agent.requestAgent,
      });
      expect(result.ok).toBe(true);
      const parsed = parseNodeSshAgentIdentities(result.ok ? result.data : null);
      expect(parsed).toEqual({
        identities: [
          { fingerprint: fp(KEY_LAPTOP), comment: "laptop key" },
          { fingerprint: fp(KEY_BACKUP), comment: "backup key" },
        ],
      });
      // The roster request went ONLY as the RESOLVED scheme's identities byte.
      const identitiesRequests = agent.sent.filter((p) => p.length === 1 && p[0] === scheme.identities);
      expect(identitiesRequests.length).toBe(2); // probe (positive confirmation) + roster ask
      if (scheme === CLASSIC_SCHEME) expect(agent.sent.length).toBe(2); // no second candidate was ever sent
      // Blobs withheld: no spelling of either blob appears in the serialized frame.
      const wire = JSON.stringify(result);
      for (const blob of [KEY_LAPTOP, KEY_BACKUP]) {
        expect(wire).not.toContain(blob.toString("base64"));
        expect(wire).not.toContain(blob.toString("base64url"));
      }
      expect(wire).not.toContain("LAPTOP-BLOB");
      expect(wire).not.toContain("BACKUP-BLOB");
    }
  });

  it("an empty roster from a live agent is the honest answer, not an error", async () => {
    const agent = scriptedAgent((p) =>
      p.equals(Buffer.from([13]))
        ? identitiesAnswer(CLASSIC_SCHEME, [])
        : (() => {
            throw new Error("never");
          })(),
    );
    const result = await execSshAgentIdentities(makeCtx(gatedDir("empty")), {
      resolveAgentSocket: () => "/fake/agent.sock",
      requestAgent: agent.requestAgent,
    });
    expect(result.ok && result.data).toEqual({ identities: [] });
  });

  it("the gate speaks FIRST: an unmirrored machine refuses before the socket or the agent", async () => {
    const agent = scriptedAgent(() => Buffer.from([5]));
    const dir = join(base, "roster-gate-off", "data");
    mkdirSync(dir, { recursive: true }); // deliberately no mirror: fail-closed OFF
    const result = await execSshAgentIdentities(makeCtx(dir), {
      resolveAgentSocket: () => "/fake/agent.sock",
      requestAgent: agent.requestAgent,
    });
    expect(result).toEqual({ ok: false, error: "ssh disabled on this node" });
    expect(agent.sent).toEqual([]);
  });

  it("no live agent socket is a named error and the agent is never asked", async () => {
    const agent = scriptedAgent(() => Buffer.from([5]));
    const result = await execSshAgentIdentities(makeCtx(gatedDir("no-sock")), {
      resolveAgentSocket: () => null,
      requestAgent: agent.requestAgent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toInclude("agent socket");
    expect(agent.sent).toEqual([]);
  });

  it("an agent that resolves NO scheme is refused by name; nothing is ever asked under a guess", async () => {
    const agent = scriptedAgent(() => Buffer.from([5]));
    const result = await execSshAgentIdentities(makeCtx(gatedDir("no-scheme")), {
      resolveAgentSocket: () => "/fake/agent.sock",
      requestAgent: agent.requestAgent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toInclude("numbering");
    expect(agent.sent).toEqual([Buffer.from([13]), Buffer.from([11])]); // both candidates probed, then refusal
  });

  it("a roster answer that does not parse is refused, never partially answered", async () => {
    // The probe (first byte-11 ask) resolves 10.x positively; the SECOND
    // byte-11 ask is the roster read, and THAT answer comes back truncated.
    let elevenAsks = 0;
    const agent = scriptedAgent((p) => {
      if (p.equals(Buffer.from([13]))) return Buffer.from([5]); // the classic candidate fails
      elevenAsks += 1;
      if (elevenAsks === 1) return identitiesAnswer(OPENSSH_10X_SCHEME, ROSTER); // probe: valid, resolves
      return Buffer.from([12, 0, 0, 0, 5, ...sshStr(KEY_LAPTOP).subarray(0, 3)]); // roster: truncated
    });
    const result = await execSshAgentIdentities(makeCtx(gatedDir("malformed")), {
      resolveAgentSocket: () => "/fake/agent.sock",
      requestAgent: agent.requestAgent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toInclude("did not parse");
  });

  it("dispatch routes the arm: a gate-ON machine with no SSH_AUTH_SOCK answers the handler's own named error, not `unsupported`", async () => {
    const saved = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = ""; // the honest no-agent spelling liveAgentSocketPath must refuse
    try {
      const result = await dispatchCommand(makeCtx(gatedDir("route")), { type: "ssh_agent_identities" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toInclude("agent socket");
        expect(result.error).not.toBe("unsupported");
      }
    } finally {
      if (saved === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = saved;
    }
  });
});
