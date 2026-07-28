import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1>
            <Link href="/" className="font-logo text-2xl font-extrabold italic text-text-primary">
              brohda.
            </Link>
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            The Social Prediction Platform.
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
