"use server";

// Server actions for the /app auth flows: register, sign in, sign out.
// Passwords are hashed with bcrypt (never stored in plaintext). All logic runs
// server-side. Distinct from the /admin Basic Auth, which is unchanged.

import { AuthError } from "next-auth";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { signIn, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { safeCallbackUrl } from "@/lib/authCallback";

export interface AuthActionState {
  error?: string;
  fieldErrors?: Record<string, string[]>;
}

const BCRYPT_ROUNDS = 12;

const emailField = z.string().trim().toLowerCase().email({ message: "Enter a valid email address." });
const passwordField = z
  .string()
  .min(8, { message: "Password must be at least 8 characters." })
  .regex(/[a-zA-Z]/, { message: "Include at least one letter." })
  .regex(/[0-9]/, { message: "Include at least one number." });

const signupSchema = z.object({
  name: z.string().trim().max(80).optional(),
  email: emailField,
  password: passwordField,
});

function safeCallback(raw: FormDataEntryValue | null): string {
  // Allow same-origin /app and /studio paths — never an open redirect.
  return safeCallbackUrl(typeof raw === "string" ? raw : null);
}

/** Register a new email/password account, then sign the user in. */
export async function signupAction(
  _prev: AuthActionState | undefined,
  formData: FormData
): Promise<AuthActionState> {
  const parsed = signupSchema.safeParse({
    name: (formData.get("name") as string) || undefined,
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { name, email, password } = parsed.data;
  const callbackUrl = safeCallback(formData.get("callbackUrl"));

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return { error: "An account with that email already exists — try signing in instead." };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await db.user.create({
    data: {
      email,
      name: name && name.length > 0 ? name : null,
      passwordHash,
      role: "USER",
    },
  });

  // Sign the new user in. signIn throws a redirect on success (expected).
  try {
    await signIn("credentials", { email, password, redirectTo: callbackUrl });
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: "Account created, but automatic sign-in failed. Please sign in." };
    }
    throw err; // re-throw the NEXT_REDIRECT
  }
  return {};
}

/** Sign in with email + password. */
export async function loginAction(
  _prev: AuthActionState | undefined,
  formData: FormData
): Promise<AuthActionState> {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  const callbackUrl = safeCallback(formData.get("callbackUrl"));

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  try {
    await signIn("credentials", { email, password, redirectTo: callbackUrl });
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: "Invalid email or password." };
    }
    throw err; // re-throw the NEXT_REDIRECT
  }
  return {};
}

/** Begin the Google OAuth flow (only wired when AUTH_GOOGLE_* env is set). */
export async function googleLoginAction(formData: FormData): Promise<void> {
  const callbackUrl = safeCallback(formData.get("callbackUrl"));
  await signIn("google", { redirectTo: callbackUrl });
}

/** Sign out and return to the public portal. */
export async function logoutAction(): Promise<void> {
  await signOut({ redirectTo: "/app" });
}
