import { ApiError } from "@internal/node-admin";

/** A plugin conflict can also return 409; only a name conflict belongs on the Name field. */
export function isDuplicatePresetName(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  if (!error.body || typeof error.body !== "object") return false;
  // Development responses retain metadataSafe under its original name.
  const metadata =
    "metadataSafe" in error.body ? error.body.metadataSafe : "metadata" in error.body ? error.body.metadata : null;
  return (
    !!metadata && typeof metadata === "object" && "reason" in metadata && metadata.reason === "duplicate_preset_name"
  );
}
