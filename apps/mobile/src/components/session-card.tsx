import { stripAnsi } from "@internal/backend-errors";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { isWaiting } from "@/lib/session-order";
import { colors, radius } from "@/lib/tokens";
import type { SessionView } from "@/types/session";

/** One list row (spec §Screens Sessions card): name, harness, dot, preview, chip, death stats. */
export const SessionCard = memo(function SessionCard({
  session,
  onOpen,
}: {
  session: SessionView;
  /** Stable identity, id-taking — keeps the memo honest when the list re-renders. */
  onOpen: (id: string) => void;
}) {
  const waiting = isWaiting(session);
  const preview = stripAnsi(session.preview.at(-1) ?? "").trim();
  return (
    <Pressable
      onPress={() => onOpen(session.id)}
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
            backgroundColor: !session.alive
              ? colors.mutedFg
              : session.activity === "active"
                ? colors.success
                : colors.warning,
          }}
        />
        <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 16, fontWeight: "600", flex: 1 }}>
          {session.name}
        </Text>
        {waiting ? (
          <Text
            style={{
              color: colors.bg,
              backgroundColor: colors.warning,
              borderRadius: 4,
              paddingHorizontal: 6,
              fontSize: 11,
              fontWeight: "700",
            }}
          >
            waiting
          </Text>
        ) : null}
      </View>
      {/* `node unreachable` outranks `exited` (web session-card, spec §5.6):
          with no live agent the exit facts are last-known, not current.
          `=== true` — an older payload without the field is online-ish. */}
      <Text style={{ color: colors.mutedFg, fontSize: 12 }}>
        {session.harnessId}
        {session.nodeOffline === true
          ? " · node unreachable"
          : !session.alive
            ? ` · exited ${session.exitCode ?? "?"}${session.backoffCount > 0 ? ` · restarts ${session.backoffCount}` : ""}`
            : ""}
      </Text>
      {preview ? (
        <Text numberOfLines={1} style={{ color: colors.mutedFg, fontSize: 12, fontFamily: "Menlo" }}>
          {preview}
        </Text>
      ) : null}
    </Pressable>
  );
});
