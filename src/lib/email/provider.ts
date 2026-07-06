// Email provider interface for account emails (verification + password reset).
//
// STATUS: DISABLED. No email provider is configured in this project (no
// Resend / SES / SMTP / Postmark env vars). The flows below are implemented
// against this interface but intentionally NOT wired to the UI, because
// verification and password-reset are meaningless without a way to deliver
// the message. Enabling them is a small, well-bounded follow-up:
//
//   TODO(email): add ONE provider and flip this on.
//     Recommended: Resend (https://resend.com) — simplest for transactional
//     email. `npm i resend`, set RESEND_API_KEY + EMAIL_FROM in Coolify, then
//     implement ResendEmailProvider below and return it from getEmailProvider().
//     Alternatives: AWS SES (the app already uses @aws-sdk for S3), or SMTP
//     via nodemailer. Once a provider returns non-null here:
//       1. Signup: create a VerificationToken and send a verify link; set
//          User.emailVerified when the link is used.
//       2. Password reset: /app/forgot + /app/reset pages that create and
//          consume a VerificationToken, then bcrypt-rehash the password.
//
// Until then, accounts are usable immediately (email/password + Google), and
// User.emailVerified stays null.

export interface AccountEmailProvider {
  /** Send an email-verification link to a newly registered address. */
  sendVerification(to: string, verifyUrl: string): Promise<void>;
  /** Send a password-reset link. */
  sendPasswordReset(to: string, resetUrl: string): Promise<void>;
}

/** True when a real transactional email provider is configured via env. */
export function isEmailConfigured(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY ||
      process.env.EMAIL_SERVER || // SMTP url (nodemailer style)
      process.env.SES_EMAIL_FROM
  );
}

/**
 * Returns the configured provider, or null when email is disabled. Callers
 * MUST handle null (that's the honest "not configured yet" state) rather than
 * pretending an email was sent.
 */
export function getEmailProvider(): AccountEmailProvider | null {
  if (!isEmailConfigured()) return null;
  // TODO(email): construct and return the real provider here once one of the
  // env vars above is set. Left unimplemented on purpose so we never silently
  // no-op a "we emailed you" promise.
  throw new Error(
    "Email env is set but no AccountEmailProvider implementation is wired. " +
      "Implement it in src/lib/email/provider.ts (see the TODO)."
  );
}
