import { Elysia } from "elysia";
import { HttpError } from "@/api/auth-guard.js";
import { readRestoreJob } from "@/services/restore-jobs.js";

// The unpredictable job UUID is a read-only status capability. Restoring revokes
// login cookies, so this exposes only generic progress, never instance metadata.
export const restoreStatusRoutes = new Elysia().get("/api/restore-status/:id", ({ params, set }) => {
  set.headers["Cache-Control"] = "no-store";
  // Read-only capability status may reconnect across a configured port change.
  set.headers["Access-Control-Allow-Origin"] = "*";
  try {
    return readRestoreJob(params.id);
  } catch {
    throw new HttpError(404, "Restore status unavailable.");
  }
});
