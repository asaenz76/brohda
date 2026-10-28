import Link from "next/link";

// The auth pages are one <main> landmark (the wordmark is its heading), so a screen-reader user can jump straight to the form. Tighter vertical space on a phone keeps the sign-up button near the top of the screen.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="flex min-h-full flex-1 items-center justify-center bg-background px-4 py-6 sm:py-12">
      <div className="w-full max-w-sm">
        <div className="mb-5 text-center sm:mb-8">
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
    </main>
  );
}
