import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import {
  isNodeSubshellId,
  type PreviewDisplayReadiness,
  type VirtualDisplayRequest,
} from "@internal/subshell-protocol";
import {
  commandRunner,
  createDisplay,
  displayName,
  ExistingDisplayError,
  inspectDisplay,
  type OwnedDisplay,
  ownedDisplay,
  parseIdentifiers,
  type Run,
  removeDisplay,
} from "./betterdisplay-cli.js";
import {
  type DisplaySweepResult,
  PREVIEW_DISPLAY_NOT_READY,
  type PreviewScreenHandle,
  type VirtualDisplayProvider,
} from "./display-provider.js";
import { type HelperStatus, helperStatus } from "./macos-helper.js";
import { MacOSRfb } from "./macos-rfb.js";

type Journal = {
  name: string;
  pid: number;
  width: number;
  height: number;
  phase: "creating" | "created";
  display?: OwnedDisplay;
};
type Bridge = Pick<MacOSRfb, "start" | "stop" | "port" | "onLost">;
export interface BetterDisplayDeps {
  platform?: string;
  kernelRelease?: string;
  status?: () => Promise<HelperStatus | null>;
  run?: Run;
  bridge?: (size: VirtualDisplayRequest, display: OwnedDisplay) => Bridge;
  alive?: (pid: number) => boolean;
  log?: (line: string) => void;
}

/** macOS shares one login desktop. This provider is not an isolated X session. */
export class BetterDisplayProvider implements VirtualDisplayProvider {
  readonly id = "betterdisplay";
  private root: string;
  private entries = new Map<string, { display: OwnedDisplay; bridge: Bridge }>();
  private lost = new Map<string, string>();
  private operations = new Map<string, Promise<void>>();
  private forPane<T>(id: string, action: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(id) ?? Promise.resolve()).then(action);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.operations.set(id, settled);
    void settled.then(() => {
      if (this.operations.get(id) === settled) this.operations.delete(id);
    });
    return result;
  }
  constructor(
    dataDir: string,
    private deps: BetterDisplayDeps = {},
  ) {
    this.root = join(dataDir, "betterdisplay-displays");
  }
  private status() {
    return (this.deps.status ?? helperStatus)();
  }
  private supported() {
    return (
      (this.deps.platform ?? process.platform) === "darwin" &&
      Number.parseInt(this.deps.kernelRelease ?? release(), 10) >= 23
    );
  }
  async readiness(): Promise<PreviewDisplayReadiness> {
    return this.checkReadiness((this.supported() && (await this.status())) || null);
  }
  private async checkReadiness(status: HelperStatus | null): Promise<PreviewDisplayReadiness> {
    if (!this.supported()) return { supported: false, missing: [] };
    if (!status?.enabled)
      return {
        supported: true,
        missing: ["Enable Virtual Display Helper in the desktop app on this node (macOS 14 or later)"],
      };
    const missing: string[] = [];
    if (!status.screenRecording) missing.push("Screen Recording permission for Subshell Display Helper");
    if (!status.accessibility) missing.push("Accessibility permission for Subshell Display Helper");
    if (!status.betterDisplayExecutable) missing.push("BetterDisplay running with CLI access enabled");
    else {
      try {
        const inventory = parseIdentifiers(
          await (this.deps.run ?? commandRunner(status.betterDisplayExecutable))(["get", "-identifiers"]),
        );
        if (!inventory.length) throw new Error("BetterDisplay didn't return an inventory");
      } catch {
        missing.push("BetterDisplay CLI access");
      }
    }
    return { supported: true, missing };
  }
  private async runner(): Promise<Run> {
    const status = await this.status();
    if (!status?.betterDisplayExecutable)
      throw new Error(`${PREVIEW_DISPLAY_NOT_READY}: Open BetterDisplay on the selected node`);
    return this.deps.run ?? commandRunner(status.betterDisplayExecutable);
  }
  private directory(id: string, root = this.root) {
    if (!isNodeSubshellId(id)) throw new Error("Invalid subshell identity");
    return join(root, id);
  }
  private save(id: string, journal: Journal) {
    const directory = this.directory(id);
    const staging = join(directory, "display.next");
    writeFileSync(staging, JSON.stringify(journal), { mode: 0o600 });
    renameSync(staging, join(directory, "display.json"));
  }
  private load(id: string, root = this.root): Journal | null {
    let text: string;
    try {
      const directory = this.directory(id, root);
      if (!lstatSync(directory).isDirectory()) throw new Error("Invalid display journal directory");
      const file = join(directory, "display.json");
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid display journal file");
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (text.length > 65536) throw new Error("Invalid BetterDisplay journal");
    const value = JSON.parse(text) as Journal;
    if (
      !value ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      !Number.isInteger(value.width) ||
      value.width < 320 ||
      value.width > 4096 ||
      !Number.isInteger(value.height) ||
      value.height < 320 ||
      value.height > 4096 ||
      typeof value.name !== "string" ||
      !/^Subshell-[0-9a-f-]{36}$/i.test(value.name) ||
      !["creating", "created"].includes(value.phase)
    )
      throw new Error("Invalid BetterDisplay journal");
    if (value.display) ownedDisplay(value.display, value.name);
    if (value.phase === "created" && !value.display) throw new Error("Missing BetterDisplay identity");
    return value;
  }
  private alive(pid: number) {
    if (this.deps.alive) return this.deps.alive(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  getFor(id: string): PreviewScreenHandle | null {
    const entry = this.entries.get(id);
    return entry ? { display: entry.display.UUID, viewer: { protocol: "vnc", port: entry.bridge.port } } : null;
  }
  launchEnv(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(PREVIEW_DISPLAY_NOT_READY);
    // Cocoa has no DISPLAY equivalent. These identify the target for tools;
    // apps still need to move their windows onto this shared desktop's screen.
    return { SUBSHELL_DISPLAY_UUID: entry.display.UUID, SUBSHELL_DISPLAY_NAME: entry.display.name };
  }
  lostFor(id: string) {
    return this.lost.get(id) ?? null;
  }
  openFor(id: string, size: VirtualDisplayRequest): Promise<PreviewScreenHandle> {
    return this.forPane(id, () => this.allocate(id, size));
  }
  private async allocate(id: string, size: VirtualDisplayRequest): Promise<PreviewScreenHandle> {
    if (this.entries.has(id)) return this.getFor(id) as PreviewScreenHandle;
    let createdDirectory = false;
    let journal: Journal | undefined;
    try {
      if (!this.supported()) throw new Error("preview-display-unsupported");
      const status = await this.status();
      const readiness = await this.checkReadiness(status);
      if (readiness.missing.length) {
        // The missing list alone could not tell us whether the helper answered
        // nothing or answered `{enabled:true,…,betterDisplayExecutable:null}`;
        // that distinction cost a long debugging session, so the raw answer
        // rides the refusal.
        this.deps.log?.(
          `betterdisplay refused pane ${id}: missing [${readiness.missing.join("; ")}] status ${JSON.stringify(status)}`,
        );
        throw new Error(`preview-display-missing-requirements: ${readiness.missing.join(", ")}`);
      }
      if (![size.width, size.height].every((n) => Number.isInteger(n) && n >= 320 && n <= 4096))
        throw new Error("Invalid display dimensions");
      if (!status?.betterDisplayExecutable) throw new Error(PREVIEW_DISPLAY_NOT_READY);
      const run = this.deps.run ?? commandRunner(status.betterDisplayExecutable);
      const previous = this.load(id);
      if (previous) {
        if (previous.pid !== process.pid && this.alive(previous.pid))
          throw new Error(`${PREVIEW_DISPLAY_NOT_READY}: Another process owns this display`);
        await this.cleanup(id, previous);
      }
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      mkdirSync(this.directory(id), { mode: 0o700 });
      createdDirectory = true;
      journal = {
        name: displayName(randomUUID()),
        pid: process.pid,
        width: size.width,
        height: size.height,
        phase: "creating",
      };
      // Persist ownership before creation so a crash never loses the exact selector.
      this.save(id, journal);
      const display = await createDisplay(run, journal.name, size.width, size.height);
      journal = { ...journal, phase: "created", display };
      this.save(id, journal);
      await this.attach(id, size, display);
      this.lost.delete(id);
      return this.getFor(id) as PreviewScreenHandle;
    } catch (error) {
      if (error instanceof ExistingDisplayError && createdDirectory) {
        rmSync(this.directory(id), { recursive: true });
      } else if (createdDirectory && journal) {
        try {
          await this.cleanup(id, journal);
        } catch {
          this.deps.log?.("BetterDisplay cleanup is pending; its ownership journal was retained.");
        }
      }
      throw error;
    }
  }
  private async attach(id: string, size: VirtualDisplayRequest, display: OwnedDisplay) {
    const bridge =
      this.deps.bridge?.(size, display) ??
      new MacOSRfb(size.width, size.height, { uuid: display.UUID, name: display.name });
    let disconnected = false;
    bridge.onLost = () => {
      disconnected = true;
      if (this.entries.get(id)?.bridge !== bridge) return;
      this.entries.delete(id);
      this.lost.set(id, "Display helper stopped or permission was revoked");
    };
    try {
      await bridge.start();
      if (disconnected) throw new Error("Display helper disconnected");
    } catch (error) {
      bridge.stop();
      throw error;
    }
    this.entries.set(id, { display, bridge });
  }
  private async cleanup(id: string, journal: Journal, root = this.root) {
    const run = await this.runner();
    const display = journal.display ?? (await inspectDisplay(run, journal.name));
    if (!display && journal.phase === "creating") {
      // A timed-out CLI mutation may finish later. Retain its unique selector
      // separately so retries and close aren't held hostage by that uncertainty.
      if (root === this.root) {
        const pending = `${this.root}-pending`;
        mkdirSync(pending, { recursive: true, mode: 0o700 });
        renameSync(this.directory(id), this.directory(randomUUID(), pending));
      }
      return;
    }
    if (display) await removeDisplay(run, display);
    rmSync(this.directory(id, root), { recursive: true });
  }
  closeFor(id: string) {
    return this.forPane(id, async () => {
      if (!this.supported()) return;
      const entry = this.entries.get(id);
      this.entries.delete(id);
      entry?.bridge.stop();
      this.lost.delete(id);
      const journal = this.load(id);
      if (!journal || (journal.pid !== process.pid && this.alive(journal.pid))) return;
      await this.cleanup(id, journal);
    });
  }
  async sweepOrphans(alivePaneIds: string[]): Promise<DisplaySweepResult> {
    const counts = { reaped: 0, rehydrated: 0, locksFreed: 0 };
    if (!this.supported()) return counts;
    const pending = `${this.root}-pending`;
    try {
      for (const id of readdirSync(pending)) {
        if (!isNodeSubshellId(id)) continue;
        try {
          const journal = this.load(id, pending);
          if (journal && (journal.pid === process.pid || !this.alive(journal.pid)))
            await this.cleanup(id, journal, pending);
        } catch {
          this.deps.log?.("BetterDisplay delayed creation cleanup is pending.");
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let ids: string[];
    try {
      ids = readdirSync(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return counts;
      throw error;
    }
    for (const id of ids) {
      if (!isNodeSubshellId(id) || this.operations.has(id) || this.entries.has(id)) continue;
      await this.forPane(id, async () => {
        try {
          const journal = this.load(id);
          if (!journal || (journal.pid !== process.pid && this.alive(journal.pid))) return;
          if (alivePaneIds.includes(id) && journal.display && (await this.readiness()).missing.length === 0) {
            const current = await inspectDisplay(await this.runner(), journal.name);
            if (!current) {
              rmSync(this.directory(id), { recursive: true });
              this.lost.set(
                id,
                "The virtual display is no longer available on this node. Restart the subshell to create one.",
              );
              counts.reaped++;
              return;
            }
            if (
              current.UUID.toLowerCase() !== journal.display.UUID.toLowerCase() ||
              current.tagID !== journal.display.tagID
            )
              throw new Error("Display identity changed");
            this.save(id, { ...journal, pid: process.pid });
            await this.attach(id, journal, current);
            this.lost.delete(id);
            counts.rehydrated++;
          } else if (!alivePaneIds.includes(id) || journal.phase === "creating") {
            await this.cleanup(id, journal);
            counts.reaped++;
          } else this.lost.set(id, "Display helper isn't available on this node");
        } catch {
          this.lost.set(
            id,
            "The virtual display couldn't be recovered. Check BetterDisplay and the helper on this node.",
          );
          this.deps.log?.("BetterDisplay recovery is pending; its ownership journal was retained.");
        }
      });
    }
    return counts;
  }
}
