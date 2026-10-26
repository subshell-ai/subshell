import { Elysia } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { HttpError } from "@/shared/errors.js";

/** Keeps enrollment and configuration opt-in, independently of ordinary REST access. */
export const nodeManagementGuard = new Elysia({ name: "node-management-guard" })
  .use(authGuard)
  .onBeforeHandle({ as: "scoped" }, ({ actor, systemKeyPermissions }) => {
    if (actor === "cookie") return;
    if (actor !== "system-key" || systemKeyPermissions === null) {
      throw new HttpError(
        403,
        "This API key cannot manage nodes. Ask an admin to create a key with the required node permissions.",
      );
    }
  })
  .as("scoped");
