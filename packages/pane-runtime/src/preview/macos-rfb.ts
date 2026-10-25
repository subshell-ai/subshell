import { createServer, type Socket } from "node:net";
import { MacOSHelper } from "./macos-helper.js";

const MAX_JPEG = 0x3f_ffff;

/** Tight's JPEG framing lets the existing noVNC viewer use native macOS capture. */
export function tightFrame(jpeg: Buffer, width: number, height: number): Buffer {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 320 ||
    height < 320 ||
    width > 4096 ||
    height > 4096 ||
    jpeg.length < 4 ||
    jpeg.length > MAX_JPEG ||
    jpeg[0] !== 0xff ||
    jpeg[1] !== 0xd8 ||
    jpeg[jpeg.length - 2] !== 0xff ||
    jpeg[jpeg.length - 1] !== 0xd9
  ) {
    throw new Error("Invalid native display frame");
  }
  const header = Buffer.alloc(17);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(width, 8);
  header.writeUInt16BE(height, 10);
  header.writeInt32BE(7, 12);
  header[16] = 0x90;
  const size: number[] = [jpeg.length & 0x7f];
  if (jpeg.length > 0x7f) {
    size[0] |= 0x80;
    size.push((jpeg.length >>> 7) & 0x7f);
    if (jpeg.length > 0x3fff) {
      size[1] |= 0x80;
      size.push(jpeg.length >>> 14);
    }
  }
  return Buffer.concat([header, Buffer.from(size), jpeg]);
}

class Viewer {
  private buffer = Buffer.alloc(0);
  private phase: "version" | "security" | "init" | "ready" = "version";
  private tight = false;
  private pending = false;
  private generation = -1;
  private timer: ReturnType<typeof setTimeout>;
  constructor(
    private socket: Socket,
    private bridge: MacOSRfb,
  ) {
    socket.setNoDelay(true);
    this.timer = setTimeout(() => socket.destroy(), 10_000);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(this.timer);
      bridge.remove(this);
    });
    socket.on("data", (bytes: Buffer) => {
      if (this.buffer.length + bytes.length > 131072) return void socket.destroy();
      this.buffer = Buffer.concat([this.buffer, bytes]);
      try {
        this.parse();
      } catch {
        socket.destroy();
      }
    });
    this.write(Buffer.from("RFB 003.008\n"));
  }
  close() {
    this.socket.destroy();
  }
  private write(bytes: Buffer) {
    if (this.socket.writableLength + bytes.length > 8 * 1024 * 1024) return void this.socket.destroy();
    this.socket.write(bytes);
  }
  frame() {
    if (!this.pending || !this.tight || !this.bridge.frame || this.generation === this.bridge.generation) return;
    this.pending = false;
    this.generation = this.bridge.generation;
    this.write(this.bridge.frame);
  }
  private take(size: number) {
    const result = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return result;
  }
  private parse() {
    while (!this.socket.destroyed) {
      if (this.phase === "version") {
        if (this.buffer.length < 12) return;
        if (this.take(12).toString() !== "RFB 003.008\n") throw new Error("RFB version");
        this.phase = "security";
        this.write(Buffer.from([1, 1]));
      } else if (this.phase === "security") {
        if (!this.buffer.length) return;
        if (this.take(1)[0] !== 1) throw new Error("RFB security");
        this.phase = "init";
        this.write(Buffer.alloc(4));
      } else if (this.phase === "init") {
        if (!this.buffer.length) return;
        this.take(1);
        const name = Buffer.from("Subshell virtual display");
        const init = Buffer.alloc(24);
        init.writeUInt16BE(this.bridge.width);
        init.writeUInt16BE(this.bridge.height, 2);
        init[4] = 32;
        init[5] = 24;
        init[7] = 1;
        init.writeUInt16BE(255, 8);
        init.writeUInt16BE(255, 10);
        init.writeUInt16BE(255, 12);
        init[14] = 16;
        init[15] = 8;
        init.writeUInt32BE(name.length, 20);
        this.write(Buffer.concat([init, name]));
        this.phase = "ready";
        clearTimeout(this.timer);
      } else {
        if (!this.buffer.length) return;
        const type = this.buffer[0];
        let size: number;
        if (type === 0) size = 20;
        else if (type === 2) {
          if (this.buffer.length < 4) return;
          const count = this.buffer.readUInt16BE(2);
          if (count > 256) throw new Error("Too many encodings");
          size = 4 + count * 4;
        } else if (type === 3) size = 10;
        else if (type === 4) size = 8;
        else if (type === 5) size = 6;
        else if (type === 6) {
          if (this.buffer.length < 8) return;
          const length = this.buffer.readUInt32BE(4);
          if (length > 65536) throw new Error("Clipboard limit");
          size = 8 + length;
        } else throw new Error("Unsupported RFB request");
        if (this.buffer.length < size) return;
        const message = this.take(size);
        if (type === 2) {
          this.tight = false;
          for (let offset = 4; offset < size; offset += 4) if (message.readInt32BE(offset) === 7) this.tight = true;
          if (!this.tight) throw new Error("The viewer needs Tight JPEG support");
        } else if (type === 3) {
          if (!message[1]) this.generation = -1;
          this.pending = true;
          this.frame();
        } else if (type === 4) {
          if (message[1] > 1) throw new Error("Invalid key event");
          this.bridge.input({ op: "key", down: message[1] === 1, symbol: message.readUInt32BE(4) }, this);
        } else if (type === 5) {
          const x = message.readUInt16BE(2),
            y = message.readUInt16BE(4);
          if (x >= this.bridge.width || y >= this.bridge.height || message[1] > 127)
            throw new Error("Invalid pointer event");
          this.bridge.input({ op: "pointer", mask: message[1], x, y }, this);
        }
        // Clipboard messages are consumed but never access the host clipboard.
      }
    }
  }
}

export class MacOSRfb {
  private helper: MacOSHelper;
  private server = createServer((socket) => {
    if (this.viewers.size >= 8 || this.closed) {
      socket.destroy();
      return;
    }
    this.viewers.add(new Viewer(socket, this));
  });
  private viewers = new Set<Viewer>();
  private controller: Viewer | null = null;
  private closed = false;
  private intentional = false;
  private ready = false;
  frame: Buffer | null = null;
  generation = 0;
  port = 0;
  onLost?: () => void;

  constructor(
    readonly width: number,
    readonly height: number,
    private identity: { uuid: string; name: string },
    socketPath?: string,
  ) {
    this.helper = new MacOSHelper(socketPath);
    this.server.on("error", () => this.close());
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The display helper didn't start capture"));
        this.close();
      }, 10000);
      this.helper.onClose = () => {
        clearTimeout(timer);
        reject(new Error("The display helper disconnected"));
        this.close();
      };
      this.helper.onMessage = (message) => {
        if (message.type === "error") {
          const reason =
            typeof message.message === "string" ? message.message.slice(0, 256) : "The display helper refused capture";
          reject(new Error(`preview-display-not-ready: ${reason}`));
          this.close();
          return;
        }
        if (message.type === "started") {
          if (message.width !== this.width || message.height !== this.height) {
            reject(new Error("The display helper returned different capture dimensions"));
            this.close();
            return;
          }
          this.ready = true;
          clearTimeout(timer);
          resolve();
        } else if (message.type === "frame") {
          if (
            message.width !== this.width ||
            message.height !== this.height ||
            typeof message.jpeg !== "string" ||
            message.jpeg.length > 5592404
          )
            return this.close();
          try {
            this.frame = tightFrame(Buffer.from(message.jpeg, "base64"), this.width, this.height);
          } catch {
            this.close();
            return;
          }
          this.generation++;
          for (const viewer of this.viewers) viewer.frame();
        }
      };
      this.helper.send({ op: "start", ...this.identity, width: this.width, height: this.height });
    });
    if (this.closed) throw new Error("The display helper disconnected");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        const address = this.server.address();
        if (this.closed || !address || typeof address === "string") {
          this.server.close();
          reject(new Error("Display listener stopped"));
          return;
        }
        this.port = address.port;
        resolve();
      });
    });
  }
  input(request: Record<string, unknown>, viewer: Viewer) {
    if (this.closed || !this.ready) return;
    if (this.controller !== viewer) this.helper.send({ op: "release" });
    this.controller = viewer;
    this.helper.send(request);
  }
  remove(viewer: Viewer) {
    this.viewers.delete(viewer);
    if (this.controller === viewer) {
      this.controller = null;
      if (!this.closed) this.helper.send({ op: "release" });
    }
  }
  stop() {
    this.intentional = true;
    this.close();
  }
  private close() {
    if (this.closed) return;
    this.closed = true;
    this.helper.close();
    this.server.close();
    for (const viewer of this.viewers) viewer.close();
    this.viewers.clear();
    this.frame = null;
    if (!this.intentional) this.onLost?.();
  }
}
