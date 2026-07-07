import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyAdminAuthHeader } from "@/lib/adminBasicAuth";

// Two different locks on two different surfaces:
//
//   /admin  — the operator console. HTTP Basic Auth, UNCHANGED. Always
//             enforced; fails closed when ADMIN_PASSWORD is unset so a missing
//             env var can never leave the operator surfaces open.
//
//   /studio — the creator app. Gated by the NextAuth end-user session in
//             src/app/studio/layout.tsx (currentUser()), NOT Basic Auth — an
//             unauthenticated visitor must be able to reach the login page and
//             be redirected, which a 401 Basic challenge here would prevent.
//             We keep /studio in the matcher only to forward the requested
//             path (x-pathname) so the layout can send the visitor back to
//             where they were headed after signing in. Auth itself is the
//             layout's job; nothing here reads the session.
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (!verifyAdminAuthHeader(request.headers.get("authorization"))) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Secure Area"',
        },
      });
    }
    return NextResponse.next();
  }

  // /studio: forward the requested path (+query) upstream so the layout can
  // build a login callbackUrl. Cloning + set() overwrites any client-supplied
  // x-pathname, so it can't be spoofed.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", `${pathname}${search || ""}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/studio", "/studio/:path*"],
};
