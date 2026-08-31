import { Tabs } from "expo-router";
import { useWaitingCount } from "@/hooks/use-summary";
import { colors } from "@/lib/tokens";

/** Compact shell (spec §Adaptive): Sessions (waiting badge) · New · Settings. */
export default function TabsLayout() {
  const waiting = useWaitingCount();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedFg,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Sessions",
          tabBarBadge: waiting > 0 ? waiting : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.warning },
        }}
      />
      <Tabs.Screen name="new" options={{ title: "New" }} />
      <Tabs.Screen name="settings" options={{ title: "Settings" }} />
    </Tabs>
  );
}
