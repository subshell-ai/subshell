/** Host capacity reported at connection time, not a measure of current free resources. */
export interface NodeSystemSpecs {
  /** Kernel/OS release reported by the operating system. */
  osRelease: string;
  /** CPU model, or null when the operating system doesn't report one. */
  cpuModel: string | null;
  /** Logical CPU count visible to the node process. */
  logicalCpuCount: number;
  /** Total host memory in bytes, not available memory or a container limit. */
  totalMemoryBytes: number;
  /** ISO timestamp of the report, retained while the node is offline. */
  reportedAt: string;
}

/** Reject malformed optional hardware reports without refusing the node connection. */
export function parseNodeSystemSpecs(value: unknown): NodeSystemSpecs | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (
    typeof r.osRelease !== "string" ||
    r.osRelease.length > 256 ||
    !(r.cpuModel === null || (typeof r.cpuModel === "string" && r.cpuModel.length <= 512)) ||
    typeof r.logicalCpuCount !== "number" ||
    !Number.isSafeInteger(r.logicalCpuCount) ||
    r.logicalCpuCount < 0 ||
    r.logicalCpuCount > 1_000_000 ||
    typeof r.totalMemoryBytes !== "number" ||
    !Number.isSafeInteger(r.totalMemoryBytes) ||
    r.totalMemoryBytes < 0 ||
    typeof r.reportedAt !== "string" ||
    r.reportedAt.length > 40 ||
    !Number.isFinite(Date.parse(r.reportedAt))
  )
    return null;
  return {
    osRelease: r.osRelease,
    cpuModel: r.cpuModel,
    logicalCpuCount: r.logicalCpuCount,
    totalMemoryBytes: r.totalMemoryBytes,
    reportedAt: r.reportedAt,
  };
}
