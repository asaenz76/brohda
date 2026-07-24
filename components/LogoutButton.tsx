import { LogOut } from "lucide-react";
import { logoutAction } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <Button variant="ghost" size="icon" type="submit" aria-label="Log out">
        <LogOut className="size-4" />
      </Button>
    </form>
  );
}
