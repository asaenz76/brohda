import type { LandingPageData } from "@/lib/landing/fetch";
import { LandingNav } from "./LandingNav";
import { LandingHero } from "./LandingHero";
import { ActivityStrip } from "./ActivityStrip";
import { HowItWorks } from "./HowItWorks";
import { ProductShowcase } from "./ProductShowcase";
import { ComparisonSection } from "./ComparisonSection";
import { CommunityStats } from "./CommunityStats";
import { FinalCta } from "./FinalCta";
import { LandingFooter } from "./LandingFooter";

export function LandingPage({ data }: { data: LandingPageData }) {
  return (
    <div className="flex min-h-full flex-col">
      <LandingNav />
      <main className="flex-1">
        <LandingHero heroPool={data.heroPool} />
        <ActivityStrip items={data.activity} />
        <HowItWorks />
        <ProductShowcase
          feedPools={data.feedPools}
          leaderboard={data.leaderboard}
          sampleAnalytics={data.sampleAnalytics}
        />
        <ComparisonSection />
        <CommunityStats stats={data.stats} />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
