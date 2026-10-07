import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultSshConfigPath,
  discoverSshAliases,
  findBinary,
  getSshSessionSupervisor,
  resolveSshAliasConfig,
} from "@internal/pane-runtime";
import { parseNodeCommandBody, SSH_CANCEL_GRACE_MS, SSH_SESSION_PUMP_CHUNK_BYTES } from "@internal/subshell-protocol";
import { SshBrokerDispatcher } from "./ssh-broker-dispatch.js";

/** Native owns this process: stdin remains open, one JSON initialization line,
 * then {type:"stop"} or EOF terminates the socket and drains its SSH children.
 * Pair tokens/credentials never appear in argv, diagnostics, or stdout.
 * Resume uses --broker-id and {} on stdin. Stdout has one attached metadata line.
 */
export function brokerServerOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new Error("Choose a server origin without a path or credentials.");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("Desktop SSH requires HTTPS, except on loopback.");
  return url.origin;
}
export function brokerCredentialPath(origin: string, id: string): string {
  if (!/^desktop:[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid desktop broker id.");
  const root = process.env.SUBSHELL_CONFIG_HOME || join(homedir(), ".config", "subshell");
  return join(root, "ssh-brokers", `${createHash("sha256").update(`${origin}\n${id}`).digest("hex")}.json`);
}
export function forgetBrokerCredential(server: string, id: string): void {
  rmSync(brokerCredentialPath(brokerServerOrigin(server), id), { force: true });
}
function readCredential(origin: string, id: string): string {
  const path = brokerCredentialPath(origin, id);
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Desktop broker credential must be a private owner file.");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    value.origin !== origin ||
    value.id !== id ||
    typeof value.credential !== "string" ||
    !/^dsb_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/.test(value.credential)
  )
    throw new Error("Invalid desktop broker credential.");
  return value.credential;
}
function saveCredential(origin: string, id: string, credential: string): void {
  const path = brokerCredentialPath(origin, id);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Desktop broker credential directory must be private.");
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ origin, id, credential }));
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export async function runSshBroker(server: string, brokerId?: string): Promise<number> {
  const origin = brokerServerOrigin(server);
  const home = process.env.HOME || homedir();
  const reader = Bun.stdin.stream().getReader();
  let initial = "";
  let remainder = "";
  const decoder = new TextDecoder();
  while (!initial.includes("\n")) {
    const part = await reader.read();
    if (part.done) throw new Error("Desktop broker requires one initialization line on stdin.");
    initial += decoder.decode(part.value, { stream: true });
    if (initial.length > 4096) throw new Error("Desktop broker initialization exceeds its bound.");
  }
  const newline = initial.indexOf("\n");
  remainder = initial.slice(newline + 1);
  initial = initial.slice(0, newline);
  const init = JSON.parse(initial) as { pairingToken?: unknown };
  if (!init || typeof init !== "object" || Array.isArray(init)) throw new Error("Invalid broker initialization.");
  const token =
    typeof init.pairingToken === "string" && /^dsp_[A-Za-z0-9_-]{43}$/.test(init.pairingToken)
      ? init.pairingToken
      : brokerId
        ? readCredential(origin, brokerId)
        : null;
  if (!token) throw new Error("Pair this desktop with your signed-in server account first.");
  const dataRoot = process.env.SUBSHELL_CONFIG_HOME || join(homedir(), ".config", "subshell");
  mkdirSync(join(dataRoot, "ssh-broker-runtime"), { recursive: true, mode: 0o700 });
  const dataDir = mkdtempSync(join(dataRoot, "ssh-broker-runtime", "process-"));
  const sshBin = await findBinary("ssh", "SUBSHELL_SSH_PATH", [
    "/usr/bin/ssh",
    "/bin/ssh",
    "/usr/local/bin/ssh",
    "/opt/homebrew/bin/ssh",
  ]);
  if (!sshBin) {
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error("SSH is not installed on this computer.");
  }
  const sup = getSshSessionSupervisor({ dataDir, homeDir: home, sshBin, nowMs: Date.now });
  const url = new URL("/api/ssh-runtime/desktop-brokers/attach", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const Ws = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const ws = new Ws(url.href, { headers: { Authorization: `Bearer ${token}` } });
  let stopping = false;
  let attached = false;
  let usedSshSession = false;
  const dispatcher = new SshBrokerDispatcher();
  let lastRequest = 0;
  let finish!: (code: number) => void;
  const completed = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const send = (frame: unknown): void => {
    if (stopping || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1024 * 1024)
      throw new Error("Desktop broker link unavailable.");
    ws.send(JSON.stringify(frame));
  };
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    clearTimeout(handshake);
    ws.close(1000, "Desktop broker stopped");
    for (const ref of sup.liveRefs()) sup.close(ref);
    // A late open closes via its liveness check before the tracked tasks settle.
    void dispatcher
      .drain()
      .catch(() => {})
      .then(async () => {
        for (const ref of sup.liveRefs()) sup.close(ref);
        if (usedSshSession) await Bun.sleep(SSH_CANCEL_GRACE_MS + 50);
        rmSync(dataDir, { recursive: true, force: true });
        finish(attached ? 0 : 1);
      });
  };
  const handshake = setTimeout(stop, 15_000);
  const signals = (): void => stop();
  process.on("SIGTERM", signals);
  process.on("SIGINT", signals);
  ws.addEventListener("close", stop);
  ws.addEventListener("error", stop);
  ws.addEventListener("message", (event) => {
    if (stopping || typeof event.data !== "string" || event.data.length > 1024 * 1024) {
      stop();
      return;
    }
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(event.data);
    } catch {
      stop();
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      stop();
      return;
    }
    if (!attached) {
      if (
        value.type !== "attached" ||
        typeof value.id !== "string" ||
        !/^desktop:[0-9a-f-]{36}$/.test(value.id) ||
        typeof value.name !== "string" ||
        (brokerId && brokerId !== value.id)
      ) {
        stop();
        return;
      }
      try {
        if (value.brokerCredential !== undefined) {
          if (
            typeof value.brokerCredential !== "string" ||
            !/^dsb_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/.test(value.brokerCredential)
          )
            throw new Error("Invalid credential.");
          saveCredential(origin, value.id, value.brokerCredential);
        }
        attached = true;
        clearTimeout(handshake);
        process.stdout.write(`${JSON.stringify({ type: "attached", id: value.id, name: value.name })}\n`);
      } catch {
        stop();
      }
      return;
    }
    const cmd = parseNodeCommandBody(value.command);
    if (
      value.type !== "command" ||
      typeof value.requestId !== "string" ||
      !/^[1-9][0-9]{0,15}$/.test(value.requestId) ||
      Number(value.requestId) !== lastRequest + 1 ||
      !cmd ||
      ![
        "ssh_discover_aliases",
        "ssh_resolve_config",
        "ssh_session_open",
        "ssh_session_send",
        "ssh_session_close",
      ].includes(cmd.type) ||
      dispatcher.size >= 32
    ) {
      stop();
      return;
    }
    // A monotonic counter provides a constant-memory replay fence. A dropped
    // result never authorizes re-sending a mutating command.
    lastRequest = Number(value.requestId);
    const requestId = value.requestId;
    const dispatch = dispatcher.dispatch(
      cmd,
      async () => {
        if (stopping) return;
        try {
          let data: unknown;
          switch (cmd.type) {
            case "ssh_discover_aliases": {
              const found = discoverSshAliases({ homeDir: home, configPath: defaultSshConfigPath(home) });
              data = { aliases: found.aliases, includeCycle: found.includeCycle, truncated: found.truncated };
              break;
            }
            case "ssh_resolve_config":
              data = await resolveSshAliasConfig(cmd.alias, {
                sshBin,
                homeDir: home,
                configPath: defaultSshConfigPath(home),
              });
              break;
            case "ssh_session_open": {
              usedSshSession = true;
              const outcome = await sup.open(
                { ref: cmd.ref, target: cmd.target, runtimeCommand: cmd.runtimeCommand ?? "subshell" },
                {
                  emitBytes: async (bytes) => {
                    for (let off = 0; off < bytes.byteLength; off += SSH_SESSION_PUMP_CHUNK_BYTES) {
                      let waits = 0;
                      while (!stopping && ws.bufferedAmount > 1024 * 1024 && waits++ < 200) await Bun.sleep(50);
                      send({
                        type: "session_frame",
                        ref: cmd.ref,
                        data_b64: Buffer.from(bytes.subarray(off, off + SSH_SESSION_PUMP_CHUNK_BYTES)).toString(
                          "base64",
                        ),
                      });
                    }
                  },
                  emitDiag: () => {},
                  onLost: () => {
                    if (!stopping) {
                      try {
                        send({ type: "session_lost", ref: cmd.ref });
                      } catch {
                        stop();
                      }
                    }
                  },
                },
              );
              if (stopping) {
                sup.close(cmd.ref);
                return;
              }
              if (outcome.kind === "refused") {
                send({ type: "result", requestId, ok: false, error: outcome.code });
                return;
              }
              data = outcome.result;
              break;
            }
            case "ssh_session_send":
              if ((await sup.sendAsync(cmd.ref, Buffer.from(cmd.data_b64, "base64"))) !== "ok")
                throw new Error("session_unknown");
              break;
            case "ssh_session_close":
              if (sup.close(cmd.ref) !== "ok") throw new Error("session_unknown");
              break;
            default:
              stop();
              return;
          }
          send({ type: "result", requestId, ok: true, ...(data !== undefined ? { data } : {}) });
        } catch (error) {
          if (!stopping) {
            try {
              send({
                type: "result",
                requestId,
                ok: false,
                error:
                  error instanceof Error && error.message === "session_unknown"
                    ? "session_unknown"
                    : "connection_failed",
              });
            } catch {
              stop();
            }
          }
        }
      },
      stop,
    );
    if (dispatch === "open_busy") {
      try {
        send({ type: "result", requestId, ok: false, error: "connection_failed" });
      } catch {
        stop();
      }
    } else if (dispatch === "full") stop();
  });
  // EOF is authority loss, including a native parent crash. Subsequent input
  // is bounded and accepts only the explicit shutdown message.
  void (async () => {
    let pending = remainder;
    while (!stopping) {
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          stop();
          return;
        }
        if (!message || typeof message !== "object" || (message as { type?: string }).type !== "stop") {
          stop();
          return;
        }
        stop();
        return;
      }
      const part = await reader.read();
      if (part.done) {
        stop();
        return;
      }
      pending += decoder.decode(part.value, { stream: true });
      if (pending.length > 4096) {
        stop();
        return;
      }
    }
  })().catch(stop);
  try {
    return await completed;
  } finally {
    process.off("SIGTERM", signals);
    process.off("SIGINT", signals);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
