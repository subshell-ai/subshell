import { createConnection, type Socket } from "node:net";
import { SSH_RELAY_FRAME_MAX_BYTES } from "@internal/subshell-protocol";

/**
 * A's live agent socket, spoken to one framed message at a time. This is the
 * ONLY path from the relay to a key (§3 item 4 / §5.4, "agent-only"): the
 * responder and the numbering probe connect to the running agent through
 * `SSH_AUTH_SOCK` and nothing else - no private key file is ever opened here,
 * and nothing about key material reaches a log line.
 *
 * The trust rule is the one {@link liveAgentSocketPath} shares with the launch
 * side (`ssh-resolve.ts`): the env sock is trusted because it is the
 * connecting account's own setup, and only an absolute path qualifies. Each
 * request rides its own one-shot connection (ssh's agent protocol permits it;
 * no session state lives on the socket), under the relay frame cap and a
 * local timeout - ssh's own agent budget is unbounded, ours may not be.
 */

/** One agent message's maximum payload: the relay frame cap (§5.1: cap is law). */
const MAX_AGENT_MESSAGE_BYTES = SSH_RELAY_FRAME_MAX_BYTES;

/** Local I/O budget for one round trip to A's agent (a local Unix socket call). */
const AGENT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The connecting account's live agent socket: an absolute `SSH_AUTH_SOCK`,
 * else null. A null answer is the honest no-agent case: the relay refuses
 * with SSH2_AGENT_FAILURE and never reads a key file (agent-only, §5.4).
 */
export function liveAgentSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const sock = env.SSH_AUTH_SOCK;
  return typeof sock === "string" && sock.startsWith("/") && sock.length > 1 ? sock : null;
}

/** Frame one agent message for the wire: 4-byte big-endian length, then the payload. */
function framing(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * One request/response round trip to A's agent over the Unix socket:
 * connect, write one framed message, read one framed answer, close. Rejects
 * on connect failure, timeout, an empty or over-cap answer, or a close before
 * a complete answer. `timeoutMs` is exposed for tests; production always uses
 * the module default. The answer's TYPE is not examined here - classifying
 * it is the caller's job in the RESOLVED scheme (relay-agent-scheme.ts).
 */
export function requestLiveAgent(socketPath: string, payload: Buffer, timeoutMs?: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let conn: Socket;
    try {
      conn = createConnection({ path: socketPath });
    } catch (err) {
      reject(new Error(`relay agent socket: cannot reach the agent socket: ${String(err)}`));
      return;
    }
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.destroy();
      } catch {
        /* already gone */
      }
      reject(new Error(`relay agent socket: ${why}`));
    };
    const timer = setTimeout(() => fail("agent request timed out"), timeoutMs ?? AGENT_REQUEST_TIMEOUT_MS);
    conn.on("error", (err: Error) => fail(`agent socket error: ${err.message}`));
    conn.on("connect", () => {
      conn.write(framing(payload));
    });
    conn.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const len = buffer.readUInt32BE(0);
      if (len === 0 || len > MAX_AGENT_MESSAGE_BYTES) {
        fail(`agent answer length ${len} is empty or over the cap`);
        return;
      }
      if (buffer.length < 4 + len) return;
      const answer = Buffer.from(buffer.subarray(4, 4 + len));
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        /* the destroy below handles it */
      }
      conn.destroy();
      resolve(answer);
    });
    conn.on("close", () => fail("the agent socket closed before a complete answer"));
  });
}
