import { FlashList } from "@shopify/flash-list";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { ActivityIndicator, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SubshellCard } from "@/components/subshell-card";
import { SubshellDetail } from "@/components/subshell-detail";
import { useIsWide } from "@/hooks/use-is-wide";
import { useSubshells } from "@/hooks/use-subshells";
import { type SubshellSections, sectionize } from "@/lib/subshell-order";
import { colors, font } from "@/lib/tokens";
import type { SubshellView } from "@/types/subshell";

type Row = { kind: "header"; title: string } | { kind: "subshell"; subshell: SubshellView };

/** Flattened section rows → one FlashList, stable identities, no section-API assumptions. */
function toRows(sections: SubshellSections): Row[] {
  const out: Row[] = [];
  const push = (title: string, list: SubshellView[]) => {
    if (list.length === 0) return;
    out.push({ kind: "header", title });
    for (const s of list) out.push({ kind: "subshell", subshell: s });
  };
  push("Waiting for you", sections.waiting);
  push("Running", sections.running);
  push("Paused / exited", sections.exited);
  push("Completed", sections.completed);
  return out;
}

/**
 * Subshells list (spec §Screens): sections mirror the web page, badge lives in
 * the tab bar. Compact pushes the full-screen detail; Regular (≥1024 px)
 * shows list ∣ detail side by side with the selection mirrored into ?sid=,
 * so deep links and state restoration land correctly (spec §Adaptive).
 */
export default function SubshellsList() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wide = useIsWide();
  const { sid } = useLocalSearchParams<{ sid?: string }>();
  const { data, error, isLoading, isRefetching, refetch } = useSubshells();

  // Memoized on the fetch result: without it every isRefetching flip rebuilt
  // the Row array with fresh object identities and the card memo never hit
  // (review, efficiency #1).
  const rows = useMemo(() => toRows(sectionize(data ?? [])), [data]);
  const open = useCallback(
    (id: string) => (wide ? router.setParams({ sid: id }) : router.push(`/subshell/${id}`)),
    [wide, router],
  );
  const closeDetail = () => router.setParams({ sid: undefined });

  if (wide) {
    return (
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ width: 380, borderRightWidth: 1, borderRightColor: colors.border, flexShrink: 0 }}>
          {listBody()}
        </View>
        <View style={{ flex: 1 }}>
          {sid ? (
            <SubshellDetail subshellId={sid} onBack={closeDetail} />
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ ...font("body"), color: colors.mutedFg }}>Select a subshell</Text>
            </View>
          )}
        </View>
      </View>
    );
  }
  return listBody();

  function listBody() {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <Text style={{ ...font("display"), color: colors.fg }}>Subshells</Text>
        </View>
        {error && !data ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
            <Text style={{ ...font("body"), color: colors.destructive }}>Cannot reach the instance</Text>
            <Text style={{ ...font("caption"), color: colors.mutedFg }}>Pull down to retry</Text>
          </View>
        ) : isLoading && !data ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator />
          </View>
        ) : rows.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
            <Text style={{ ...font("body"), color: colors.mutedFg }}>Nothing running. Start one from the New tab.</Text>
          </View>
        ) : (
          <FlashList
            data={rows}
            refreshControl={
              <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.mutedFg} />
            }
            keyExtractor={(r, _i) => (r.kind === "subshell" ? r.subshell.id : `h-${r.title}`)}
            renderItem={({ item }) =>
              item.kind === "header" ? (
                <Text
                  style={{
                    ...font("caption"),
                    color: colors.mutedFg,
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
                  <SubshellCard subshell={item.subshell} onOpen={open} />
                </View>
              )
            }
          />
        )}
      </View>
    );
  }
}
