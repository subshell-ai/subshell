import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** A responding port alone cannot prove which display it belongs to. */
export function ownsDisplayListener(pid: number, port: number, procRoot = "/proc"): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const processDir = join(procRoot, String(pid));
    const inodes = new Set<string>();
    for (const line of readFileSync(join(processDir, "net", "tcp"), "utf8")
      .split("\n")
      .slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, portHex] = (fields[1] ?? "").split(":");
      // x11vnc's -localhost listener must serve exactly the IPv4 loopback
      // address used by the broker, with an fd held by this child.
      if (fields[3] === "0A" && address === "0100007F" && parseInt(portHex ?? "", 16) === port && fields[9])
        inodes.add(`socket:[${fields[9]}]`);
    }
    for (const fd of readdirSync(join(processDir, "fd"))) {
      try {
        if (inodes.has(readlinkSync(join(processDir, "fd", fd)))) return true;
      } catch {
        // File descriptors can close while the process stays alive.
      }
    }
  } catch {
    // An unreadable or vanished process cannot establish ownership.
  }
  return false;
}
