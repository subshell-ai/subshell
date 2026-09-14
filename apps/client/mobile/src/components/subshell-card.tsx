import { stripAnsi } from "@internal/backend-errors";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { isNodeOffline, isWaiting } from "@/lib/subshell-order";
import { colors, font, radius } from "@/lib/tokens";
import type { SubshellView } from "@/types/subshell";

/** One list row (spec §Screens Subshells card): name, harness, dot, preview, chip, death stats. */
export const SubshellCard = memo(function SubshellCard({
  subshell,
  onOpen,
}: {
  subshell: SubshellView;
  /** Stable identity, id-taking — keeps the memo honest when the list re-renders. */
  onOpen: (id: string) => void;
}) {
  // Offline gate (web posture, spec §5.6 — T16 review (2)): with no live
  // agent, `alive`/`activity`/`waitingSince` are last-known facts, so nothing
  // on the row may claim CURRENT observable state — unreachable outranks
  // waiting/activity. The subtitle's "node unreachable" (below) is the only
  // state an offline card asserts. (The `=== true` posture lives in
  // `isNodeOffline`.)
  const offline = isNodeOffline(subshell);
  const waiting = !offline && isWaiting(subshell);
  const preview = stripAnsi(subshell.preview.at(-1) ?? "").trim();
  return (
    <Pressable
      onPress={() => onOpen(subshell.id)}
      style={{
        backgroundColor: colors.card,
        borderRadius: radius,
        padding: 12,
        gap: 4,
        borderWidth: 1,
        borderColor: waiting ? colors.warning : colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: offline
              ? // Unreachable asserts nothing: not working, not idle, not dead.
                colors.border
              : !subshell.alive
                ? colors.mutedFg
                : subshell.activity === "active"
                  ? colors.success
                  : colors.warning,
          }}
        />
        <Text numberOfLines={1} style={{ ...font("label"), color: colors.fg, flex: 1 }}>
          {subshell.name}
        </Text>
        {waiting ? (
          <Text
            style={{
              ...font("detail"),
              color: colors.bg,
              backgroundColor: colors.warning,
              borderRadius: 4,
              paddingHorizontal: 6,
            }}
          >
            waiting
          </Text>
        ) : null}
      </View>
      {/* `node unreachable` outranks `exited` (web subshell-card, spec §5.6):
          with no live agent the exit facts are last-known, not current. */}
      <Text style={{ ...font("detail"), color: colors.mutedFg }}>
        {subshell.harnessId}
        {offline
          ? " · node unreachable"
          : !subshell.alive
            ? ` · exited ${subshell.exitCode ?? "?"}${subshell.backoffCount > 0 ? ` · restarts ${subshell.backoffCount}` : ""}`
            : ""}
      </Text>
      {preview ? (
        <Text numberOfLines={1} style={{ ...font("detail"), color: colors.mutedFg, fontFamily: "Menlo" }}>
          {preview}
        </Text>
      ) : null}
    </Pressable>
  );
});
