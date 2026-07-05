import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Web API-safe base64 decoder
function atobSafe(str: string): string | null {
  try {
    return atob(str);
  } catch (e) {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Protect the operator console (/admin) and the studio (/studio)
  if (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/studio" ||
    pathname.startsWith("/studio/")
  ) {
    const authEnabled = process.env.ADMIN_BASIC_AUTH_ENABLED === "true";
    if (!authEnabled) {
      return NextResponse.next();
    }

    const authHeader = request.headers.get("authorization");
    // Reject missing or non-Basic Authorization headers
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Secure Area"',
        },
      });
    }

    try {
      const base64Credentials = authHeader.substring(6).trim();
      const decoded = atobSafe(base64Credentials);
      if (!decoded) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Secure Area"',
          },
        });
      }

      const colonIndex = decoded.indexOf(":");
      if (colonIndex === -1) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Secure Area"',
          },
        });
      }

      const username = decoded.substring(0, colonIndex);
      const password = decoded.substring(colonIndex + 1);

      const expectedUsername = process.env.ADMIN_USERNAME || "admin";
      const expectedPassword = process.env.ADMIN_PASSWORD;

      if (!expectedPassword || username !== expectedUsername || password !== expectedPassword) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Secure Area"',
          },
        });
      }
    } catch (err) {
      // Do not log credentials or leak them in errors
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Secure Area"',
        },
      });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/studio", "/studio/:path*"],
};
