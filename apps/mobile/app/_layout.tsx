import { Stack } from "expo-router";

/**
 * Root layout. The adaptive phone/tablet shell (bottom tabs under 1024px,
 * sidebar + list + detail above it) lands with the session screens; until then
 * a bare stack keeps the router wiring honest.
 */
export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
