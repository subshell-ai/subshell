import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const MACOS_HELPER_SOCKET = join(homedir(), "Library/Caches/Subshell/display-helper/control.sock");
export interface HelperStatus {
  enabled: boolean;
  screenRecording: boolean;
  accessibility: boolean;
  betterDisplayExecutable: string | null;
}

/** Connecting is read-only: neither the daemon nor MCP can launch or enable it. */
export class MacOSHelper {
  private socket: Socket;
  private buffer = Buffer.alloc(0);
  private closed = false;
  onMessage?: (message: Record<string, unknown>) => void;
  onClose?: () => void;

  constructor(path = MACOS_HELPER_SOCKET) {
    this.socket = connect(path);
    this.socket.on("error", () => this.close());
    this.socket.on("close", () => this.close());
    this.socket.on("data", (data: Buffer) => {
      if (this.buffer.length + data.length > 6 * 1024 * 1024) return this.close();
      this.buffer = Buffer.concat([this.buffer, data]);
      while (true) {
        const newline = this.buffer.indexOf(10);
        if (newline === -1) break;
        const line = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        try {
          const message: unknown = JSON.parse(line.toString("utf8"));
          if (!message || typeof message !== "object" || Array.isArray(message)) return this.close();
          this.onMessage?.(message as Record<string, unknown>);
        } catch {
          this.close();
        }
        if (this.closed) return;
      }
    });
  }

  send(request: Record<string, unknown>) {
    if (this.closed) return;
    const bytes = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(bytes) > 65536 || this.socket.writableLength > 65536) return this.close();
    this.socket.write(bytes);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.buffer = Buffer.alloc(0);
    this.onClose?.();
    this.onClose = undefined;
    this.onMessage = undefined;
  }
}

export function helperStatus(path = MACOS_HELPER_SOCKET): Promise<HelperStatus | null> {
  return new Promise((resolve) => {
    const helper = new MacOSHelper(path);
    let done = false;
    const finish = (status: HelperStatus | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      helper.close();
      resolve(status);
    };
    const timer = setTimeout(() => finish(null), 2000);
    helper.onClose = () => finish(null);
    helper.onMessage = (message) => {
      if (
        message.type !== "status" ||
        message.protocol !== 1 ||
        typeof message.enabled !== "boolean" ||
        typeof message.screenRecording !== "boolean" ||
        typeof message.accessibility !== "boolean"
      )
        return finish(null);
      const executable = message.betterDisplayExecutable;
      if (
        executable !== null &&
        (typeof executable !== "string" ||
          !executable.startsWith("/") ||
          !executable.endsWith("BetterDisplay.app/Contents/MacOS/BetterDisplay") ||
          executable.includes("\0"))
      )
        return finish(null);
      finish({
        enabled: message.enabled,
        screenRecording: message.screenRecording,
        accessibility: message.accessibility,
        betterDisplayExecutable: executable,
      });
    };
    helper.send({ op: "status" });
  });
}
