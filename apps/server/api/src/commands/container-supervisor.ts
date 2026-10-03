import { resolve } from "node:path";
import { configEnvAppliedKeys } from "@/config-env.js";

/** PID 1 stays alive while a restore worker replaces the serving child. */
export async function runContainerSupervisor(args: string[]): Promise<number> {
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
