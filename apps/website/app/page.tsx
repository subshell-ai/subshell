import { InstallColumn } from "../components/install-column";
import releases from "../data/releases.json";
import type { ReleasesManifest } from "../lib/releases";

export default function Home() {
  return (
    <main className="min-h-screen p-6">
      <InstallColumn manifest={releases as ReleasesManifest} />
    </main>
  );
}
