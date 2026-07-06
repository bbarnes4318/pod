// Server-side session helpers for /app. Any server component or server action
// can call these to get the authenticated end user (or null). This is the
// plumbing the ownership work (next task) scopes records against.
//
// Distinct from adminAuth.ts: that guards /admin+/studio via Basic Auth; this
// is the /app end-user session from Auth.js.

import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export interface AppUser {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  role: string;
}

/** The signed-in end user, or null. Safe to call from any server context. */
export async function currentUser(): Promise<AppUser | null> {
  const session = await auth();
  const u = session?.user;
  if (!u?.id) return null;
  return {
    id: u.id,
    email: u.email ?? null,
    name: u.name ?? null,
    image: u.image ?? null,
    role: u.role ?? "USER",
  };
}

/** True if a user is signed in. */
export async function isAuthenticated(): Promise<boolean> {
  return (await currentUser()) !== null;
}

/**
 * For PROTECTED PAGES: return the user or redirect to login, preserving where
 * they were headed via callbackUrl so they land back after signing in.
 */
export async function requireUserPage(callbackUrl: string): Promise<AppUser> {
  const user = await currentUser();
  if (!user) {
    redirect(`/app/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }
  return user;
}

/**
 * For SERVER ACTIONS: return the user id or throw. Actions can't redirect the
 * caller cleanly, so they fail loudly and the client surfaces the error.
 */
export async function requireUserId(): Promise<string> {
  const user = await currentUser();
  if (!user) {
    throw new Error("You must be signed in to do that.");
  }
  return user.id;
}
