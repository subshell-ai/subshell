import { cpus, release, totalmem } from "node:os";
import type { NodeSystemSpecs } from "@internal/subshell-protocol";

/** Read host capacity using OS APIs, without spawning probes or loading hardware tools. */
export function readSystemSpecs(): NodeSystemSpecs {
  const processors = cpus();
  return {
    osRelease: release().slice(0, 256),
    cpuModel: processors[0]?.model.slice(0, 512) || null,
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    reportedAt: new Date().toISOString(),
  };
}
