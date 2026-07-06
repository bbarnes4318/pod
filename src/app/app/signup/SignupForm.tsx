"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signupAction, googleLoginAction, type AuthActionState } from "@/lib/authActions";

export default function SignupForm({
  callbackUrl,
  googleEnabled,
}: {
  callbackUrl: string;
  googleEnabled: boolean;
}) {
  const [state, formAction, pending] = useActionState<AuthActionState | undefined, FormData>(
    signupAction,
    undefined
  );
  const fe = state?.fieldErrors;

  return (
    <>
      {state?.error && (
        <div className="uAuthError" role="alert">
          {state.error}
        </div>
      )}

      <form action={formAction} className="uAuthForm" style={{ marginTop: state?.error ? "1rem" : 0 }}>
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <div className="uField">
          <label className="uFieldLabel" htmlFor="name">Name <span className="uAuthHint">(optional)</span></label>
          <input id="name" name="name" type="text" autoComplete="name" placeholder="Your name" className="uInput" />
          {fe?.name?.[0] && <span className="uFieldError">{fe.name[0]}</span>}
        </div>
        <div className="uField">
          <label className="uFieldLabel" htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            className="uInput"
            aria-invalid={fe?.email ? "true" : undefined}
          />
          {fe?.email?.[0] && <span className="uFieldError">{fe.email[0]}</span>}
        </div>
        <div className="uField">
          <label className="uFieldLabel" htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            placeholder="At least 8 characters"
            className="uInput"
            aria-invalid={fe?.password ? "true" : undefined}
          />
          {fe?.password?.[0] ? (
            <span className="uFieldError">{fe.password[0]}</span>
          ) : (
            <span className="uAuthHint">Use 8+ characters with a letter and a number.</span>
          )}
        </div>
        <button type="submit" className="uAuthBtn" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </button>
      </form>

      {googleEnabled && (
        <>
          <div className="uAuthDivider">or</div>
          <form action={googleLoginAction}>
            <input type="hidden" name="callbackUrl" value={callbackUrl} />
            <button type="submit" className="uGoogleBtn">
              <GoogleIcon />
              Sign up with Google
            </button>
          </form>
        </>
      )}

      <div className="uAuthAlt">
        Already have an account?{" "}
        <Link href={`/app/login${callbackUrl !== "/app" ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ""}`}>
          Sign in
        </Link>
      </div>
    </>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.02-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.02 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}
