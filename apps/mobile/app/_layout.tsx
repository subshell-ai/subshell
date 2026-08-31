import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { colors } from "@/lib/tokens";
import { MoteProvider } from "@/providers/mote-provider";

/** Root: dark chrome, providers once, every route below sees useMote()/queries. */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <MoteProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        />
      </MoteProvider>
    </SafeAreaProvider>
  );
}
