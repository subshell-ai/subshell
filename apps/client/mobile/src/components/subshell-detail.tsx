import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { confirmAction } from "@/components/confirm-action";
import { LiveHost } from "@/components/live-host";
import { PromptModal } from "@/components/prompt-modal";
import { SUBSHELLS_KEY } from "@/hooks/query-keys";
import { useSubshellData } from "@/hooks/use-subshell-data";
import { useSubshellLog } from "@/hooks/use-subshell-log";
import type { SubshellClient } from "@/lib/api";
import { errMessage, isAlreadyGone } from "@/lib/api-error";
import { useApp } from "@/lib/app-state";
import { subshellActionFlags } from "@/lib/subshell-access";
import { isNodeOffline, isWaiting } from "@/lib/subshell-order";
import { colors, font, radius, touchTarget } from "@/lib/tokens";
import { requireBiometric } from "@/native/biometric";
import { useSubshell } from "@/providers/subshell-provider";

/**
 * The detail body (spec §Screens Detail): status pill from the poll, the
 * Live∣Log tabs, and the full action bar. Destructive actions confirm;
 * a 404 after an action converges on "gone" via isAlreadyGone rather than
 * erroring. Restart is IN-PLACE — same id, deep links survive (53654a8).
 * Extracted from the route so the wide shell (task 14) embeds the same body.
 */
export function SubshellDetail({ subshellId, onBack }: { subshellId: string; onBack?: () => void }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { client } = useSubshell();
  const qc = useQueryClient();
  const wsBlocked = useApp((s) => s.instances.find((r) => r.id === s.activeId)?.wsBlocked ?? false);
  const { data: subshell, refetch, error } = useSubshellData(subshellId);
  const [tab, setTab] = useState<"live" | "log">("log");
  const [modal, setModal] = useState<"name" | null>(null);
  const log = useSubshellLog(subshellId, tab === "log");

  function gone(err: unknown): boolean {
    if (isAlreadyGone(err)) {
      void qc.invalidateQueries({ queryKey: SUBSHELLS_KEY });
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
  async function run(label: string, fn: (cli: SubshellClient) => Promise<unknown>) {
    if (!client) return;
    // Same posture as the Live tab: actions that can type into a pane (or end
    // one) require the biometric (spec §Security notes).
    if (!(await requireBiometric(`Confirm: ${label}`))) return;
    try {
      await fn(client);
      await Promise.all([refetch(), qc.invalidateQueries({ queryKey: SUBSHELLS_KEY })]);
    } catch (err) {
      if (!gone(err)) Alert.alert(label, errMessage(err, "Request failed"));
    }
  }

  if (error && !subshell) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
        <Text style={{ ...font("body"), color: colors.destructive }}>
          {errMessage(error, "Cannot load this subshell")}
        </Text>
      </View>
    );
  }

  // `node unreachable` outranks every other reading (web detail badge, spec
  // §5.6): with no live node, alive/waitingSince are last-known facts.
  // (`isNodeOffline` carries the `=== true` posture — older payloads
  // without the field never read as unreachable.)
  const pill = !subshell
    ? { text: "…", color: colors.mutedFg }
    : isNodeOffline(subshell)
      ? { text: "node unreachable", color: colors.warning }
      : isWaiting(subshell)
        ? { text: "waiting for you", color: colors.warning }
        : subshell.alive
          ? { text: "running", color: colors.success }
          : subshell.status === "terminated"
            ? { text: "completed", color: colors.mutedFg }
            : { text: "exited", color: colors.mutedFg };

  // Viewer-relative access drives the action bar and live input (spec §4.1).
  const flags = subshellActionFlags(subshell?.access);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {onBack ? null : (
            <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 6 }}>
              <Text style={{ ...font("heading"), color: colors.primary }}>‹</Text>
            </Pressable>
          )}
          <Text numberOfLines={1} style={{ ...font("heading"), color: colors.fg, flex: 1 }}>
            {subshell?.name ?? "Subshell"}
          </Text>
          <Text style={{ ...font("detail"), color: pill.color }}>{pill.text}</Text>
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
              <Text
                style={{ ...font("label"), color: tab === t ? colors.fg : colors.mutedFg, textTransform: "capitalize" }}
              >
                {t}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {tab === "live" ? (
        !client ? null : wsBlocked ? (
          // Standing banner (spec §Error handling): this proxy forwards HTTP
          // but not upgrades — every other screen still works.
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 6 }}>
            <Text style={{ ...font("heading"), color: colors.warning }}>Terminal blocked on this instance</Text>
            <Text style={{ ...font("detail"), color: colors.mutedFg, textAlign: "center" }}>
              WebSocket upgrades do not tunnel. Re-probe from Settings once the proxy forwards them.
            </Text>
          </View>
        ) : (
          <LiveHost client={client} subshellId={subshellId} active readOnly={!flags.canInput} />
        )
      ) : log.isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ ...font("detail"), color: colors.mutedFg }}>Loading log…</Text>
        </View>
      ) : (
        <FlatList
          data={log.data?.lines ?? []}
          renderItem={({ item }) => (
            <Text style={{ ...font("detail"), color: colors.fg, fontFamily: "Menlo", paddingHorizontal: 12 }}>
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
          {/* The bell and deletion are owner-only (spec §4.1); edit grantees
            manage the subshell but do not decide its owner's push posture. */}
          {flags.isOwner && (
            <Action
              label={subshell?.notify ? "Bell on" : "Bell off"}
              color={subshell?.notify ? colors.warning : colors.primary}
              onPress={() => void run("Bell", (cli) => cli.setNotify(subshellId, !(subshell?.notify ?? false)))}
            />
          )}
          <Action
            label="Restart"
            onPress={() =>
              confirmAction(
                "Restart in place?",
                "Revives the same subshell (same id), resuming the conversation when possible.",
                "Restart",
                () => void run("Restart", (cli) => cli.restart(subshellId)),
              )
            }
          />
          {/* No Terminate action (spec 2026-09-03): Close stops the process
              AND removes the row, and stop-without-delete had no use-case. */}
          {flags.isOwner && (
            <Action
              label="Close"
              color={colors.destructive}
              onPress={() =>
                confirmAction(
                  "Close?",
                  "Stops the process and removes the subshell and its history permanently. It cannot be recovered.",
                  "Close",
                  () =>
                    void run("Close", async (cli) => {
                      await cli.deleteSubshell(subshellId);
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
          title="Subshell name"
          initial={subshell?.name ?? ""}
          onDone={(value) => {
            setModal(null);
            if (value === null || !client || !subshell) return;
            const name = value.trim();
            if (name && name !== subshell.name) void run("Rename", () => client.rename(subshellId, name));
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
      <Text style={{ ...font("label"), color }}>{label}</Text>
    </Pressable>
  );
}
