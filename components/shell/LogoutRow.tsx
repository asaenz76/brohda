import { LogOut } from "lucide-react";
import { logoutAction } from "@/lib/actions/auth";
import { cn } from "@/lib/utils";

// Log out as a labelled row (icon + text) for the rail and the phone menu —
// the icon-only LogoutButton stays for the admin shell.
export function LogoutRow({ className }: { className?: string }) {
  return (
    <form action={logoutAction}>
      <button
        type="submit"
        className={cn(
          "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-text-secondary outline-none hover:bg-surface-secondary hover:text-text-primary focus-visible:ring-3 focus-visible:ring-ring/50",
          className,
        )}
      >
        <LogOut className="size-4 shrink-0" aria-hidden="true" />
        Log out
      </button>
    </form>
  );
}
