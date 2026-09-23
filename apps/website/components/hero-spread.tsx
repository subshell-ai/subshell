import { InstallColumn } from "../components/install-column";
import { PhoneCard } from "../components/phone-card";
import type { ReleasesManifest } from "../lib/releases";

/**
 * The approved 27-live spread: promise left (left-aligned — Theo reverted the
 * centering on 27-live), the phone dead center at its natural ratio, install
 * right. Below 980px the columns stack in that same order.
 */
export function HeroSpread({ manifest }: { manifest: ReleasesManifest }) {
  return (
    <div className="mx-auto grid w-full max-w-[1220px] items-center gap-12 py-6 [grid-template-columns:minmax(0,1fr)_min(300px,54vw)_minmax(0,1fr)] max-[980px]:block max-[980px]:space-y-6">
      <div className="min-w-0 max-[980px]:mb-6">
        <h1 className="m-0 text-[clamp(28px,2.9vw,42px)] font-bold leading-[1.12] tracking-[-.035em]">
          Manage multiple agents <span className="text-[var(--orchid)]">away from your desk</span>
        </h1>
        <p className="mt-4 max-w-[36ch] text-[clamp(14px,1.1vw,16px)] text-[var(--dim)]">
          Your agents keep working after you walk away. View progress, get notified, and give feedback from any device
          with Subshell.
        </p>
      </div>
      <div className="max-[980px]:mx-auto max-[980px]:w-[min(260px,72vw)]">
        <PhoneCard />
      </div>
      <div className="max-[980px]:mt-6">
        <InstallColumn manifest={manifest} />
      </div>
    </div>
  );
}
