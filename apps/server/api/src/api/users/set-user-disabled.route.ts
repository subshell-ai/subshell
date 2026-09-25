import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { requireManageableUser } from "@/api/users/require-manageable-user.js";
import { UsersError } from "@/api/users/users-error.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { audit } from "@/services/audit.js";
import { disconnectNode, getHeld, getLive, OWNER_DISABLED_CLOSE_CODE } from "@/services/nodes/node-registry.js";
import { failConnPendings } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";
import { dropLiveSocketsFor } from "@/ws/live-registry.js";
import { dropTerminalSocketsFor } from "@/ws/viewers.js";
import { dropUserTokensFor } from "@/ws/ws-token.js";

const DisabledBodySchema = t.Object({
  disabled: t.Boolean({ description: "True to disable the account, false to re-enable it" }),
});

const DisabledResponseSchema = t.Object({
  id: t.String({ description: "User id" }),
  email: t.String({ description: "User email" }),
  disabled: t.Boolean({ description: "The account's state after the change" }),
  sessionsRevoked: t.Number({
    description:
      "How many of that user's sessions were signed out. A disable always evicts every one of them; re-enabling revokes nothing, so this is 0",
  }),
});

/**
 * `PATCH /api/users/:id/disabled` — disables or re-enables a user (admin only,
 * cookie session).
 */
export const setUserDisabledRoute = new Elysia().use(requireAdmin).patch(
  "/:id/disabled",
  async ({ params, body, user }) => {
    const target = await requireManageableUser(params.id);
    // Same rule as the self-role refusal, for the same reason: disabling
    // yourself signs you out immediately, and only another admin could
    // reverse it — on a single-admin instance, nobody could.
    if (target.id === user.id) {
      throw new UsersError(
        "bad_request",
        "You cannot disable your own account. Another admin has to do it for you.",
        400,
      );
    }
    // The guard is inside the repository because the count, the flag write
    // and the session revocation must be one transaction — see setDisabled.
    const result = await new UserMetaRepository(db).setDisabled(target.id, body.disabled);
    if (!result.ok) {
      throw new UsersError(
        "conflict",
        "This is the only admin who can still sign in. Promote or re-enable someone else first, or the instance would be left with nobody who can administer it.",
      );
    }
    // The drop mirrors the role change in `set-user-role.route.ts`, for the
    // same structural reason — a live feed socket authenticates at connect
    // and is never re-checked, so revoking the session rows leaves an open
    // dashboard tab
    // streaming. The feed socket was only the FIRST socket, though: the
    // live half of the account is three stores, and the disable ends all
    // three, in this order —
    //
    //   1. outstanding ws-tokens (`dropUserTokensFor`). Redemption
    //      consults the store alone, never the account, so a token minted
    //      inside its 30 s life moments ago would re-create exactly the
    //      socket the next two lines end. Dropped FIRST so no redemption
    //      can land between the sweep and itself.
    //   2. open terminal attaches (`dropTerminalSocketsFor`) — the same
    //      never-re-checked rule as the feed, in a registry the feed sweep
    //      never walked. Keyed by the user, so it reaches a pane shared
    //      INTO the account and skips bystanders on the account's own.
    //   3. live feed sockets (`dropLiveSocketsFor`), as before.
    //
    // DISABLE-only: the next connect cannot even mint a ws-token while the
    // flag is set (the mint runs through authGuard, and the attach's own
    // cookie fallback re-asks `accountDisabled`), so nothing can hold a
    // stale socket across a re-enable and that edge drops nothing. Each
    // count lands in the audit row exactly as the demotion's does; the two
    // new ones join `nodesDisconnected` as disable-only keys.
    const tokensRevoked = body.disabled ? dropUserTokensFor(target.id) : 0;
    const terminalSocketsClosed = body.disabled ? dropTerminalSocketsFor(target.id, "account disabled") : 0;
    const droppedSockets = body.disabled ? dropLiveSocketsFor(target.id, "account disabled") : 0;
    // Operator ruling 2026-09-24: disabling an account takes its enrolled
    // nodes offline too, and this is the half that makes it true NOW —
    // `authenticateNodeUpgrade` refuses every later dial-in while the flag
    // stands, so the agents' backoff loop (capped at 60 s per retry) stays
    // outside until an admin re-enables, at which point the very next dial
    // succeeds. This is the deliberate "Honor over infrastructure-
    // preservation" choice: a disabled person's machines stop being
    // reachable by anyone they were shared with, immediately.
    //
    // The drain order is the registry's documented contract: capture each
    // record BEFORE evicting it, fail its in-flight commands AFTER (the
    // rotate/delete routes are the precedent). `local` is skipped by name —
    // it runs no agent and holds no socket, and an accidental close of it
    // would be a lie about what was disconnected. `disconnectNode` itself
    // owns the projection — the row flips offline and the node's running
    // panes are re-announced before this call returns, because the close
    // event that lands later will (correctly) find the entry gone and
    // skip — so the Nodes page and the live feed tell the truth with the
    // response, not at the stale sweep.
    let nodesDisconnected = 0;
    if (body.disabled) {
      // The sweep is AFTER the flag commits, so a throw here must not turn
      // into a 500 on a disable that already succeeded — the response the
      // admin gets must match the durable truth, and the durable truth is
      // the pre-socket gate that refuses every later dial regardless of
      // what this loop managed. What a failed sweep leaves behind is
      // ALREADY-OPEN sockets reaching the next reconnect, so the failure is
      // logged, not swallowed: the log names the count reached, and the
      // next dial-in is refused by `authenticateNodeUpgrade`. The
      // `listByOwner` read is inside the guard for the same reason — a
      // transient there is the same degraded-and-honest case, not a 500.
      try {
        for (const node of await new NodesRepository(db).listByOwner(target.id)) {
          if (node.kind === "local") continue;
          // Drain whatever records exist — the eviction now takes BOTH a
          // held and a live socket for one node, so the captured set is a
          // pair, not a single.
          const conns = [getLive(node.id), getHeld(node.id)?.conn];
          if (await disconnectNode(node.id, OWNER_DISABLED_CLOSE_CODE, "the node's owner account is disabled")) {
            for (const conn of conns) if (conn) failConnPendings(conn, "offline");
            nodesDisconnected++;
          }
        }
      } catch (err) {
        logger
          .withError(err)
          .warn(
            `users: disable of ${target.id} committed, but its node disconnect sweep failed after ${nodesDisconnected} disconnect(s) — later dials are refused by the upgrade-time owner check, live sockets drop with their owners' next reconnect`,
          );
      }
    }
    await audit({
      actorUserId: user.id,
      action: "user.disabled_change",
      targetType: "user",
      targetId: target.id,
      // The user-management family's convention: create/role/reset/disable
      // rows name their subject by email, because every admin already sees
      // every email (`GET /api/users` is the instance-wide read, §3) — the
      // trail hides nothing from its audience that it must answer, and it
      // answers who without a join. The never-values rule belongs to the
      // credential family: key text, tokens, and auth-event values stay
      // out of metadata everywhere. The counts are the act — an operator
      // reconstructs what the disable cut.
      metadataJson: JSON.stringify({
        email: target.email,
        disabled: body.disabled,
        droppedSockets,
        // Disable-only counts, the `nodesDisconnected` rule: the keys exist
        // when the act cut something and are absent on a re-enable, so the
        // shape says which edge ran. `tokensRevoked` first because the
        // sweep order above starts there.
        ...(body.disabled ? { tokensRevoked, terminalSocketsClosed, nodesDisconnected } : {}),
      }),
    });
    return {
      id: target.id,
      email: target.email,
      disabled: body.disabled,
      sessionsRevoked: result.sessionsRevoked,
    } as const;
  },
  {
    params: t.Object({ id: t.String({ description: "User id to disable or re-enable" }) }),
    body: DisabledBodySchema,
    response: DisabledResponseSchema,
    detail: {
      operationId: "setUserDisabled",
      tags: ["users"],
      description:
        "Disables or re-enables a user (admin only, cookie session). A disabled account cannot sign in and every credential it holds is refused; disabling signs out all of its sessions, revokes its outstanding attach tokens, closes its live feed and terminal sockets, and disconnects the nodes it owns — they stay offline until re-enabled. Refuses with 400 on self and with 409 when it would disable the last admin who can still sign in. Re-enabling is never refused",
    },
  },
);
