import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { confirmAction } from "@/components/confirm-action";
import { LiveHost } from "@/components/live-host";
import { PromptModal } from "@/components/prompt-modal";
import { SESSIONS_KEY } from "@/hooks/query-keys";
import { useSession } from "@/hooks/use-session";
import { useSessionLog } from "@/hooks/use-session-log";
import type { MoteClient } from "@/lib/api";
import { errMessage, isAlreadyGone } from "@/lib/api-error";
import { useApp } from "@/lib/app-state";
import { sessionActionFlags } from "@/lib/session-access";
import { isWaiting } from "@/lib/session-order";
import { colors, radius, touchTarget } from "@/lib/tokens";
import { requireBiometric } from "@/native/biometric";
import { useMote } from "@/providers/mote-provider";

/**
 * The detail body (spec §Screens Detail): status pill from the poll, the
 * Live∣Log tabs, and the full action bar. Destructive actions confirm;
 * a 404 after an action converges on "gone" via isAlreadyGone rather than
 * erroring. Restart is IN-PLACE — same id, deep links survive (53654a8).
 * Extracted from the route so the wide shell (task 14) embeds the same body.
 */
export function SessionDetail({ sessionId, onBack }: { sessionId: string; onBack?: () => void }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { client } = useMote();
  const qc = useQueryClient();
  const wsBlocked = useApp((s) => s.instances.find((r) => r.id === s.activeId)?.wsBlocked ?? false);
  const { data: session, refetch, error } = useSession(sessionId);
  const [tab, setTab] = useState<"live" | "log">("log");
  const [modal, setModal] = useState<"name" | "notes" | null>(null);
  const log = useSessionLog(sessionId, tab === "log");

  function gone(err: unknown): boolean {
    if (isAlreadyGone(err)) {
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      if (onBack) onBack();
      else router.back();
      return true;
    }
    return false;
  }

  /**
   * One guarded action: null-check, biometric, run, refresh. The callback
   * receives the non-null client as an argument — deliberately NOT `client!`
   * inside the callbacks: the build graph runs biome's --write --unsafe before
   * type-checking, and its noNonNullAssertion fix rewrites `client!.x()` into
   * `client?.x()`, which returns `Promise<T> | undefined` and breaks tsc
   * (CI incident 2026-08-31). An injected parameter cannot be rewritten.
   */
  async function run(label: string, fn: (cli: MoteClient) => Promise<unknown>) {
    if (!client) return;
    // Same posture as the Live tab: actions that can type into a pane (or end
    // one) require the biometric (spec §Security notes).
    if (!(await requireBiometric(`Confirm: ${label}`))) return;
    try {
      await fn(client);
      await Promise.all([refetch(), qc.invalidateQueries({ queryKey: SESSIONS_KEY })]);
    } catch (err) {
      if (!gone(err)) Alert.alert(label, errMessage(err, "Request failed"));
    }
  }

  if (error && !session) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
        <Text style={{ color: colors.destructive }}>{errMessage(error, "Cannot load this session")}</Text>
      </View>
    );
  }

  // `node unreachable` outranks every other reading (web detail badge, spec
  // §5.6): with no live agent, alive/waitingSince are last-known facts.
  // `=== true` so older payloads without the field never read as unreachable.
  const pill = !session
    ? { text: "…", color: colors.mutedFg }
    : session.nodeOffline === true
      ? { text: "node unreachable", color: colors.warning }
      : isWaiting(session)
        ? { text: "waiting for you", color: colors.warning }
        : session.alive
          ? { text: "running", color: colors.success }
          : session.status === "terminated"
            ? { text: "completed", color: colors.mutedFg }
            : { text: "exited", color: colors.mutedFg };

  // Viewer-relative access drives the action bar and live input (spec §4.1).
  const flags = sessionActionFlags(session?.access);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {onBack ? null : (
            <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 6 }}>
              <Text style={{ color: colors.primary, fontSize: 20 }}>‹</Text>
            </Pressable>
          )}
          <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 19, fontWeight: "700", flex: 1 }}>
            {session?.name ?? "Session"}
          </Text>
          <Text style={{ color: pill.color, fontSize: 12, fontWeight: "700" }}>{pill.text}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {(["live", "log"] as const).map((t) => (
            <Pressable
              key={t}
              onPress={() => setTab(t)}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 6,
                borderRadius: radius,
                backgroundColor: tab === t ? colors.accent : "transparent",
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ color: tab === t ? colors.fg : colors.mutedFg, textTransform: "capitalize" }}>{t}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {tab === "live" ? (
        !client ? null : wsBlocked ? (
          // Standing banner (spec §Error handling): this proxy forwards HTTP
          // but not upgrades — every other screen still works.
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 6 }}>
            <Text style={{ color: colors.warning, fontWeight: "600" }}>Terminal blocked on this instance</Text>
            <Text style={{ color: colors.mutedFg, fontSize: 12, textAlign: "center" }}>
              WebSocket upgrades do not tunnel. Re-probe from Settings once the proxy forwards them.
            </Text>
          </View>
        ) : (
          <LiveHost client={client} sessionId={sessionId} active readOnly={!flags.canInput} />
        )
      ) : log.isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: colors.mutedFg }}>Loading log…</Text>
        </View>
      ) : (
        <FlatList
          data={log.data?.lines ?? []}
          renderItem={({ item }) => (
            <Text style={{ color: colors.fg, fontFamily: "Menlo", fontSize: 12, paddingHorizontal: 12 }}>
              {item.length > 0 ? item : " "}
            </Text>
          )}
          refreshControl={
            <RefreshControl
              refreshing={log.isRefetching}
              onRefresh={() => void log.refetch()}
              tintColor={colors.mutedFg}
            />
          }
          style={{ flex: 1, backgroundColor: colors.termCanvas }}
          contentContainerStyle={{ paddingVertical: 10 }}
        />
      )}

      {flags.showActions && (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            padding: 12,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.card,
            paddingBottom: insets.bottom + 12,
          }}
        >
          <Action label="Rename" onPress={() => setModal("name")} />
          <Action label="Notes" onPress={() => setModal("notes")} />
          {/* The bell and deletion are owner-only (spec §4.1); edit grantees
            manage the session but do not decide its owner's push posture. */}
          {flags.isOwner && (
            <Action
              label={session?.notify ? "Bell on" : "Bell off"}
              color={session?.notify ? colors.warning : colors.primary}
              onPress={() => void run("Bell", (cli) => cli.setNotify(sessionId, !(session?.notify ?? false)))}
            />
          )}
          <Action
            label="Restart"
            onPress={() =>
              confirmAction(
                "Restart in place?",
                "Revives the same session (same id), resuming the conversation when possible.",
                "Restart",
                () => void run("Restart", (cli) => cli.restart(sessionId)),
              )
            }
          />
          <Action
            label="Terminate"
            onPress={() =>
              confirmAction(
                "Terminate?",
                "Kills the pane. Restart can revive it.",
                "Terminate",
                () => void run("Terminate", (cli) => cli.terminate(sessionId)),
                { destructive: true },
              )
            }
          />
          {flags.isOwner && (
            <Action
              label="Delete"
              color={colors.destructive}
              onPress={() =>
                confirmAction(
                  "Delete?",
                  "Removes the session for good.",
                  "Delete",
                  () =>
                    void run("Delete", async (cli) => {
                      await cli.deleteSession(sessionId);
                      if (onBack) onBack();
                      else router.back();
                    }),
                  { destructive: true },
                )
              }
            />
          )}
        </View>
      )}

      {modal ? (
        <PromptModal
          title={modal === "name" ? "Session name" : "Notes"}
          initial={modal === "name" ? (session?.name ?? "") : (session?.notes ?? "")}
          multiline={modal === "notes"}
          onDone={(value) => {
            setModal(null);
            if (value === null || !client || !session) return;
            if (modal === "name") {
              const name = value.trim();
              if (name && name !== session.name) void run("Rename", () => client.rename(sessionId, name));
            } else {
              void run("Notes", () => client.setNotes(sessionId, value.trim() === "" ? null : value));
            }
          }}
        />
      ) : null}
    </View>
  );
}

/** One action-bar text button (44px row via the container's padding). */
function Action({ label, color = colors.primary, onPress }: { label: string; color?: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{ minHeight: touchTarget - 8, justifyContent: "center", paddingHorizontal: 10 }}
    >
      <Text style={{ color, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
