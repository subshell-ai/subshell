/** How the request authenticated — drives permission and admin policy. */
export type GuardActor = "cookie" | "system-key" | "subshell-key";
