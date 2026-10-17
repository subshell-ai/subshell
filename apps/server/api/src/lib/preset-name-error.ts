import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";

/** Keep duplicate names distinguishable from other 409s without parsing display copy. */
export function duplicatePresetName(message: string): never {
  return throwApiError({
    code: BackendErrorCodes.EXISTS_ERROR,
    message,
    metadataSafe: { reason: "duplicate_preset_name", field: "name" },
    doNotLog: true,
  });
}
