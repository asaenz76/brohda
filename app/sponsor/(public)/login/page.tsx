import Link from "next/link";
import { SponsorLoginForm } from "./login-form";

export const metadata = { title: "Sponsor log in — brohda." };

export default async function SponsorLoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[]; verified?: string }> }) {
  const params = await searchParams;
  const next = Array.isArray(params.next) ? params.next[0] : params.next;
  return (
    <div className="space-y-4">
      <SponsorLoginForm next={next ?? null} verified={params.verified === "1"} />
      <p className="text-center text-sm text-text-secondary">
        New here?{" "}
        <Link href="/sponsor/signup" className="underline underline-offset-4">
          Become a Sponsor
        </Link>
      </p>
    </div>
  );
}
