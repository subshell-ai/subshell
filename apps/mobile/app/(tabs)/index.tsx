import { FlashList } from "@shopify/flash-list";
import { useRouter } from "expo-router";
import { ActivityIndicator, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionCard } from "@/components/session-card";
import { useSessions } from "@/hooks/use-sessions";
import { sectionize } from "@/lib/session-order";
import { colors } from "@/lib/tokens";
import type { SessionView } from "@/types/session";

type Row = { kind: "header"; title: string } | { kind: "session"; session: SessionView };

/** Flattened section rows → one FlashList, stable identities, no section-API assumptions. */
function toRows(sections: ReturnType<typeof sectionize>): Row[] {
  const out: Row[] = [];
  const push = (title: string, list: SessionView[]) => {
    if (list.length === 0) return;
    out.push({ kind: "header", title });
    for (const s of list) out.push({ kind: "session", session: s });
  };
  push("Waiting for you", sections.waiting);
  push("Running", sections.running);
  push("Paused / exited", sections.exited);
  push("Completed", sections.completed);
  return out;
}

/** Sessions list (spec §Screens): sections mirror the web page, badge lives in the tab bar. */
export default function SessionsList() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, error, isLoading, isRefetching, refetch } = useSessions();

  const rows = toRows(sectionize(data ?? []));

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Text style={{ color: colors.fg, fontSize: 26, fontWeight: "700" }}>Sessions</Text>
      </View>
      {error && !data ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Text style={{ color: colors.destructive }}>Cannot reach the instance</Text>
          <Text style={{ color: colors.mutedFg, fontSize: 12 }}>Pull down to retry</Text>
        </View>
      ) : isLoading && !data ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator />
        </View>
      ) : rows.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Text style={{ color: colors.mutedFg }}>Nothing running. Start one from the New tab.</Text>
        </View>
      ) : (
        <FlashList
          data={rows}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.mutedFg} />
          }
          keyExtractor={(r, _i) => (r.kind === "session" ? r.session.id : `h-${r.title}`)}
          renderItem={({ item }) =>
            item.kind === "header" ? (
              <Text
                style={{
                  color: colors.mutedFg,
                  fontSize: 12,
                  fontWeight: "700",
                  textTransform: "uppercase",
                  marginTop: 14,
                  marginBottom: 4,
                  paddingHorizontal: 16,
                }}
              >
                {item.title}
              </Text>
            ) : (
              <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                <SessionCard session={item.session} onPress={() => router.push(`/session/${item.session.id}`)} />
              </View>
            )
          }
        />
      )}
    </View>
  );
}
