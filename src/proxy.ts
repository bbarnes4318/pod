import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Protect /admin and /admin/*
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    const authEnabled = process.env.ADMIN_BASIC_AUTH_ENABLED === "true";
    if (!authEnabled) {
      return NextResponse.next();
    }

    const authHeader = request.headers.get("authorization");
    if (!authHeader) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Secure Area"',
        },
      });
    }

    try {
      const authValue = authHeader.split(" ")[1];
      const decoded = Buffer.from(authValue, "base64").toString("utf-8");
      const [username, password] = decoded.split(":");

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
  matcher: ["/admin", "/admin/:path*"],
};
