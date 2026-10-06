import { createServerClient } from "@supabase/ssr";
import { loginHrefFor, REQUEST_PATH_HEADER } from "@/lib/auth/safe-next";
import { NextResponse, type NextRequest } from "next/server";
import { needsProfileCompletionRedirect } from "@/lib/auth/profile-gate";

const PROTECTED_PREFIXES = ["/feed", "/my-picks", "/activity", "/profile", "/admin"];
const ADMIN_PREFIX = "/admin";

export async function updateSession(request: NextRequest) {
  // Hand server components the path (and query) the visitor actually asked for, so requireUser() can send a logged-out visitor to
  // /login?next=<that page> for every authenticated route, not only the few prefixes guarded below. Always overwritten here — a
  // client-supplied value is never trusted — and sanitised again before it is ever used.
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set(REQUEST_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  let supabaseResponse = NextResponse.next({ request: { headers: forwardedHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request: { headers: forwardedHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: do not run code between createServerClient and getUser().
  // A simple mistake could make it very hard to debug issues with users
  // being randomly logged out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Server Action invocations POST to the current page's own URL, so an
  // expired-session redirect issued here — a raw HTTP redirect — arrives
  // instead of the streamed action-response payload the client's action
  // runtime is waiting for, which it can't parse ("An unexpected response
  // was received from the server"), even though every action already
  // re-checks auth itself via requireUser()/requireAdminOrAbove()/
  // requireSuperAdmin() (defense in depth, not solely relying on this
  // middleware). Skipping the redirect here for action requests lets that
  // real guard's own redirect() run inside the action, which Next.js does
  // encode correctly for the client to follow.
  const isServerAction = request.headers.has("next-action");

  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix));

  if (isProtected && !user && !isServerAction) {
    // Keep the query string (a bare pathname loses it) and refuse anything that isn't a safe internal path.
    return NextResponse.redirect(new URL(loginHrefFor(`${path}${request.nextUrl.search}`), request.url));
  }

  if (user) {
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("role, is_active, username")
      .eq("id", user.id)
      .single();

    if (path.startsWith(ADMIN_PREFIX) && !isServerAction) {
      if (
        !profile ||
        !["super_admin", "admin"].includes(profile.role) ||
        !profile.is_active
      ) {
        return NextResponse.redirect(new URL("/feed", request.url));
      }
    }

    // Every account needs a username before doing anything else — force
    // it here rather than trusting each page to check individually.
    if (profile && needsProfileCompletionRedirect(path, profile.username) && !isServerAction) {
      const redirectUrl = new URL("/profile", request.url);
      redirectUrl.searchParams.set("tab", "edit");
      redirectUrl.searchParams.set("required", "1");
      return NextResponse.redirect(redirectUrl);
    }
  }

  return supabaseResponse;
}
