import { Analytics } from "../components/analytics";
import { DeskShot } from "../components/desk-shot";
import { Features } from "../components/features";
import { HeroSpread } from "../components/hero-spread";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import releases from "../data/releases.json";
import type { ReleasesManifest } from "../lib/releases";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col px-6 pb-4 pt-6">
      <SiteHeader />
      <HeroSpread manifest={releases as ReleasesManifest} />
      <DeskShot />
      <Features />
      <div className="mt-8">
        <SiteFooter />
      </div>
      <Analytics id={process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID} />
    </main>
  );
}
