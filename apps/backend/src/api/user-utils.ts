import type { User } from "better-auth";
import { db } from "@/db/index.js";

/** Whether the given authed user has the admin role. */
export async function isAdmin(user: Pick<User, "id">): Promise<boolean> {
  const row = await db.selectFrom("userMeta").select("role").where("userId", "=", user.id).executeTakeFirst();
  return row?.role === "admin";
}
