import type { User } from "better-auth";
import { db } from "@/db/index.js";

/** Whether the given authed user has the admin role. */
export async function isAdmin(user: Pick<User, "id">): Promise<boolean> {
  const row = await db.selectFrom("userMeta").select("role").where("userId", "=", user.id).executeTakeFirst();
  return row?.role === "admin";
}

/**
 * The ONE spelling of the cookie-admin invariant: a HUMAN admin is a
 * live session COOKIE whose user_meta role is "admin". The actor clause is
 * load-bearing, not decoration — authGuard maps a bearer token's `user` to
 * its session OWNER (a bearer is never rejected just because its owner is
 * an admin), so `isAdmin` alone would paint admin chrome and flags from an
 * admin-owned machine token. Callers that ENFORCE still need their own
 * 403s; this is the shape both enforcement and viewer-side flags share.
 */
export async function isCookieAdmin(user: Pick<User, "id">, actor: string): Promise<boolean> {
  return actor === "cookie" && (await isAdmin(user));
}
