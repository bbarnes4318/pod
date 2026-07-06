// Auth.js (NextAuth v5) configuration for the /app user portal.
//
// This is entirely separate from the /admin + /studio HTTP Basic Auth
// (see adminBasicAuth.ts / adminAuth.ts / proxy.ts) — those operator gates are
// untouched. End users of /app authenticate here.
//
// Strategy: JWT sessions. The Credentials (email+password) provider is
// fundamentally incompatible with Auth.js database sessions, so we use signed
// JWT cookies. The Prisma adapter still persists User + Account rows (so OAuth
// links and the User table stay the source of truth); the JWT just carries the
// user id + role for fast server-side checks. Cookies are httpOnly + sameSite
// + secure-in-prod and CSRF-protected by Auth.js defaults.
//
// Required env (set in Coolify — never committed):
//   AUTH_SECRET            — signing secret (openssl rand -base64 33)
//   AUTH_URL / NEXTAUTH_URL — canonical origin, e.g. https://podcast.hopwhistle.com
//   AUTH_TRUST_HOST=true   — needed behind the reverse proxy
//   AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET — optional; enables "Sign in with Google"

import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";

/** Google is only wired when its keys are present, so the app runs fine with
 *  email/password alone until the operator adds OAuth credentials. */
export const googleAuthConfigured = Boolean(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
);

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const providers: NextAuthConfig["providers"] = [
  Credentials({
    name: "Email and password",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    authorize: async (raw) => {
      const parsed = credentialsSchema.safeParse(raw);
      if (!parsed.success) return null;
      const email = parsed.data.email.trim().toLowerCase();
      const user = await db.user.findUnique({ where: { email } });
      // No user, or an OAuth-only account with no password set.
      if (!user || !user.passwordHash) return null;
      const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
      if (!ok) return null;
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        role: user.role,
      };
    },
  }),
];

if (googleAuthConfigured) {
  providers.unshift(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      // Do not auto-link a Google login to an existing password account with
      // the same email unless that email is verified by Google (default is
      // false = safest; a password user must sign in with their password).
      allowDangerousEmailAccountLinking: false,
    })
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" },
  trustHost: true,
  pages: {
    signIn: "/app/login",
  },
  providers,
  callbacks: {
    // Carry the user id + role on the JWT so server-side checks don't need a
    // db round-trip for authorization decisions.
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role ?? "USER";
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) ?? session.user.id;
        (session.user as { role?: string }).role = (token.role as string) ?? "USER";
      }
      return session;
    },
  },
});
