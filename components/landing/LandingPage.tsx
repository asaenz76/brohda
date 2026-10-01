import type { LandingPageData } from "@/lib/landing/fetch";
import { LandingNav } from "./LandingNav";
import { LandingHero } from "./LandingHero";
import { HowItWorks } from "./HowItWorks";
import { ComparisonSection } from "./ComparisonSection";
import { CommunityStats } from "./CommunityStats";
import { FinalCta } from "./FinalCta";
import { LandingFooter } from "./LandingFooter";

export function LandingPage({ data }: { data: LandingPageData }) {
  return (
    <div className="flex min-h-full flex-col">
      <LandingNav />
      <main className="flex-1">
        <LandingHero />
        <HowItWorks />
        <ComparisonSection />
        <CommunityStats stats={data.stats} />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
