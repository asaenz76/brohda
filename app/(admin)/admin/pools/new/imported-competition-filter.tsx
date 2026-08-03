import Link from "next/link";
import { Label } from "@/components/ui/label";
import { SELECT_CLASS, type CompetitionOption } from "./template-cards";

// Narrows the fixture list in Step 1 of both the single- and multi-fixture
// wizards down to one already-imported competition. Deliberately sourced
// only from `competitions` (built from the already-gated fixtures list,
// see buildCompetitionOptions) — this never has access to the live
// provider catalog, so there's no way for pool creation to surface a
// competition that hasn't actually been imported.
export function ImportedCompetitionFilter({
  competitions,
  value,
  onChange,
}: {
  competitions: CompetitionOption[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor="competitionFilter">Competition</Label>
        <Link href="/admin/competitions" className="text-xs font-medium text-accent-primary hover:underline">
          + Import another competition
        </Link>
      </div>
      <select
        id="competitionFilter"
        className={SELECT_CLASS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All imported competitions</option>
        {competitions.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
            {c.tier ? ` · Tier ${c.tier}` : ""} ({c.fixtureCount})
          </option>
        ))}
      </select>
    </div>
  );
}
