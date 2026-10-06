import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  parseSshRuntimeHello,
  type SshConnectionSnapshotWire,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";

/**
 * The broker's per-destination facts (design 2026-10-05 §3/§6): the pieces
 * the supervisor composes BEFORE and AROUND a spawn that are not about the
 * child's lifecycle - the deterministic tmux socket name that makes a second
 * session to the same machine land on the same server, the approved snapshot
 * a session target renders to, and the hello-boundary scan that is the
 * broker's ONLY frame awareness. Split from `ssh-session-supervisor.ts` the
 * way `ssh-render.ts` is split from the run family.
 */

/* ------------------------------------------------------------------ */
/* deterministic per-destination tmux socket (design §6 reconciliation) */
/* ------------------------------------------------------------------ */

/**
 * `subshell-ssh-<hash>` for one destination: a second session opened against
 * the same `host:port:user` lands on the same tmux server, which is what makes
 * "the next session finds the first session's panes" work. Hashed (sha1, 12
 * hex, exactly the `tmuxSocketFor` naming rules) because the name rides a
 * `-L` argument and must never embed punctuation; same-input-same-name is the
 * whole reconciliation protocol and is pinned by test.
 */
export function sshSessionTmuxSocket(host: string, port: number, user: string | null): string {
  const hash = createHash("sha1")
    .update(`${host}:${port}:${user ?? ""}`)
    .digest("hex")
    .slice(0, 12);
  return `subshell-ssh-${hash}`;
}

/* ------------------------------------------------------------------ */
/* the snapshot the broker renders (target facts under an unchanged policy) */
/* ------------------------------------------------------------------ */

/**
 * Build the approved snapshot for a session target. The trust refs are the
 * connecting account's OWN default files (design §8: keys and config stay on
 * the connecting node); the auth agent is deliberately excluded - a brokered
 * session is keys-only (§3). ProxyJump is out of the slice's target grammar;
 * the renderer supports it the moment a later workstream widens the target.
 * Returns null when the snapshot grammar refuses the facts (the caller names
 * `config_ambiguous` then; it cannot happen for parsed targets, and the belt
 * is here because this is the last station before a render).
 */
export function sessionTargetSnapshot(target: SshSessionTargetWire, homeDir: string): SshConnectionSnapshotWire {
  return {
    alias: target.alias,
    host: target.host,
    user: target.user,
    port: target.port,
    identityFiles: target.identityFile === null ? [] : [target.identityFile],
    certificateFiles: [],
    authAgentSocket: null,
    knownHostsFiles: [join(homeDir, ".ssh", "known_hosts"), "/etc/ssh/ssh_known_hosts"],
    hostKeyAlias: null,
    proxyJumps: [],
    proxyCommand: null,
    forwards: null,
    tunnels: null,
    localCommands: null,
    remoteCommand: null,
    sendEnv: null,
    setEnv: null,
    escapes: null,
  };
}

/** The connecting account's name for the open result (a display fact; null when the OS says nothing). */
export function safeUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* hello boundary scan (the broker's ONLY frame awareness)             */
/* ------------------------------------------------------------------ */

/** The hello-boundary outcome: the hello plus the bytes after it, or a named protocol verdict. */
export type HelloScan =
  | { kind: "hello"; hello: NonNullable<ReturnType<typeof parseSshRuntimeHello>>; rest: Uint8Array }
  | { kind: "incomplete" }
  /** Well-framed bytes that are NOT a hello, or a prefix too nonsense to be a frame: the stream is speaking something else. */
  | { kind: "protocol" };

/**
 * Scan buffered bytes for the length-prefixed hello frame. This is NOT the
 * codec imported at the ends: it cannot fail-closed a session on a verdict
 * the codec alone owns - but it must recognize the hello boundary, and the
 * ONE thing it treats as terminal (a complete frame that is not a hello, or a
 * lying prefix) is exactly what the codec would also kill. The duplication of
 * the 4-byte read is the price of the broker never importing the runtime
 * grammar beyond the hello, and the codec's own tests pin this same shape.
 */
export function scanForHello(buf: Uint8Array): HelloScan {
  for (;;) {
    if (buf.byteLength < 4) return { kind: "incomplete" };
    const declared = new DataView(buf.buffer as ArrayBuffer, buf.byteOffset).getUint32(0, false);
    if (declared === 0 || declared > 262_144) return { kind: "protocol" };
    if (buf.byteLength < 4 + declared) return { kind: "incomplete" };
    const body = buf.subarray(4, 4 + declared);
    const rest = buf.slice(4 + declared);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return { kind: "protocol" };
    }
    const hello = parseSshRuntimeHello(parsed);
    if (hello !== null) return { kind: "hello", hello, rest };
    return { kind: "protocol" };
  }
}

/** Concatenate two byte views (the pump buffer's only growth operation). */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
