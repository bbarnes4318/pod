import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyAdminAuthHeader } from "@/lib/adminBasicAuth";

// Protect the operator console (/admin) and the studio (/studio).
// Always enforced — fails closed when ADMIN_PASSWORD is unset. The old
// ADMIN_BASIC_AUTH_ENABLED opt-in flag is intentionally ignored so a missing
// env var can never leave the operator surfaces open.
export function proxy(request: NextRequest) {
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

export const config = {
  matcher: ["/admin", "/admin/:path*", "/studio", "/studio/:path*"],
};
