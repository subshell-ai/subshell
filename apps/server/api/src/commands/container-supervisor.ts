import { resolve } from "node:path";
import { configEnvAppliedKeys, serverConfigDir } from "@/config-env.js";
import { activeRestoreHold, clearRestoreHold } from "@/services/restore-hold.js";

/** PID 1 stays alive while a restore worker replaces the serving child. */
export async function runContainerSupervisor(args: string[]): Promise<number> {
  // A marker left on the volume by a worker killed before it could clear
  // (an OOM, or `docker stop`'s final SIGKILL) is never legitimate for THIS
  // boot: the swap it named died with the previous container. Sweep it before
  // the first spawn, or a later pid reuse would make `activeRestoreHold` defer
  // forever and the server never start.
  clearRestoreHold(serverConfigDir());
  let stopping = false;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  const stop = () => {
    stopping = true;
    child?.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const script = process.argv[1];
  const argv = /subshell/.test(process.execPath.split("/").pop() ?? "")
    ? [process.execPath]
    : [process.execPath, resolve(script as string)];
  try {
    while (!stopping) {
      // A control-plane restore worker holds the instance swap: respawning
      // while its marker names a live process would race it for the lock the
      // restore was refused for losing. A dead worker's stale marker never
      // holds, and SIGTERM ends the wait within one half-second poll.
      while (!stopping && activeRestoreHold(serverConfigDir())) await Bun.sleep(500);
      if (stopping) break;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        SUBSHELL_CONTAINER: "1",
        SUBSHELL_CONTAINER_SUPERVISOR_PID: String(process.pid),
      };
      // Read config.env afresh on each serving boot, including restored identity
      // secrets. The parent's first config read must not become an env override.
      for (const key of configEnvAppliedKeys()) delete env[key];
      child = Bun.spawn({
        cmd: [...argv, ...args],
        env: env as Record<string, string>,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      await child.exited;
      child = null;
      if (!stopping) await Bun.sleep(5000);
    }
    return 0;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
