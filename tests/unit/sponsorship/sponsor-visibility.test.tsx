import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewQueue } from "@/components/sponsorship/ReviewQueue";
import { DEFAULT_SPONSOR_VISIBILITY, parseSponsorVisibility } from "@/lib/sponsorship/sponsor-visibility";
import type { SponsorRecord } from "@/lib/sponsorship/repository";

vi.mock("server-only", () => ({}));
afterEach(() => cleanup());

const sponsor = (o: Partial<SponsorRecord> & { hiddenAt?: string | null } = {}) => ({ id: "s1", displayName: "Acme Sports", legalName: null, contactEmail: null, logoPath: null, logoUrl: null, website: null, country: null, contactName: "Ana", contactPhone: null, status: "PENDING_REVIEW", statusReason: null, reviewedAt: null, createdAt: "2026-10-01T12:00:00Z", ...o }) as SponsorRecord & { hiddenAt?: string | null };

describe("Sponsor list visibility parsing", () => {
  it("defaults to visible; only the three known values are accepted; anything else falls back to visible", () => {
    expect(DEFAULT_SPONSOR_VISIBILITY).toBe("visible");
    expect(parseSponsorVisibility(undefined)).toBe("visible");
    expect(parseSponsorVisibility(null)).toBe("visible");
    for (const v of ["visible", "hidden", "all"] as const) expect(parseSponsorVisibility(v)).toBe(v);
    expect(parseSponsorVisibility(["hidden", "all"])).toBe("hidden");
    for (const odd of ["", "ALL", "Hidden", "true", "*", "hidden,all"]) expect(parseSponsorVisibility(odd)).toBe("visible");
  });
});

describe("a hidden application still surfaces in the Review queue — marked, and linking to where it can be decided", () => {
  it("a visible application: no badge, plain link", () => {
    const { container } = render(<ReviewQueue sponsorApplications={[sponsor()]} sponsorships={[]} />);
    expect(container.querySelector('[data-slot="hidden-badge"]')).toBeNull();
    expect(container.querySelector('[data-sponsor-id="s1"] a')).toHaveAttribute("href", "/admin/sponsorship/sponsors#sponsor-s1");
  });
  it("a hidden application: a Hidden badge, and a link that reveals hidden Sponsors so the anchor exists", () => {
    const { container } = render(<ReviewQueue sponsorApplications={[sponsor({ hiddenAt: "2026-10-05T00:00:00Z" })]} sponsorships={[]} />);
    expect(container.querySelector('[data-slot="hidden-badge"]')).toHaveTextContent("Hidden");
    expect(container.querySelector('[data-sponsor-id="s1"] a')).toHaveAttribute("href", "/admin/sponsorship/sponsors?show=all#sponsor-s1");
  });
});

describe("hidden-ness is admin list visibility ONLY — enforced at the source", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(n)) out.push(p);
    }
    return out;
  };
  const MARKERS = /sponsor_admin_hidden|admin_set_sponsor_hidden|hiddenAt|hidden_at|setSponsorHiddenAction|hiddenSponsorMap/;

  it("only the repository, the admin action, the Sponsors admin page/manager and the Review queue know about it — never eligibility, public rendering, payments, the Sponsor session, legal or notifications", () => {
    const allowed = new Set([
      "lib/sponsorship/repository.ts",
      "lib/actions/admin-sponsorship.ts",
      "lib/sponsorship/sponsor-visibility.ts",
      "components/sponsorship/ReviewQueue.tsx",
      "app/(admin)/admin/sponsorship/sponsors/page.tsx",
      "app/(admin)/admin/sponsorship/sponsors/sponsors-manager.tsx",
    ]);
    const hits = [...walk("app"), ...walk("lib"), ...walk("components")].filter((f) => MARKERS.test(read(f)) && !allowed.has(f));
    expect(hits).toEqual([]);
  });

  it("there is no Sponsor deletion anywhere — hide/unhide is the only cleanup", () => {
    for (const f of [...walk("app"), ...walk("lib"), ...walk("components")]) {
      const src = read(f).replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/from\(["']sponsors["']\)\s*\.delete|from\(["']sponsor_accounts["']\)\s*\.delete|delete\s+from\s+public\.sponsors/i);
    }
  });

  it("the hide action is Super Admin-only and the visibility field is never read by Sponsor-side code", () => {
    expect(read("lib/actions/admin-sponsorship.ts")).toMatch(/export async function setSponsorHiddenAction[\s\S]{0,200}requireSuperAdmin\(\)/);
    for (const f of [...walk("app/sponsor"), ...walk("lib/sponsor")]) expect(MARKERS.test(read(f)), f).toBe(false);
  });
});
