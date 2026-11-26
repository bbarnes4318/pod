import AuthFrame from "../AuthFrame";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/currentUser";
import { googleAuthConfigured } from "@/lib/auth";
import { safeCallbackUrl } from "@/lib/authCallback";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

function normalizeCallback(v: string | string[] | undefined): string {
  return safeCallbackUrl(v);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;
  const target = normalizeCallback(callbackUrl);

  // Already signed in → go where they were headed.
  if (await currentUser()) redirect(target);

  return (
    <AuthFrame title="Sign in" subtitle="Welcome back. Sign in to your studio.">
      <LoginForm callbackUrl={target} googleEnabled={googleAuthConfigured} />
    </AuthFrame>
  );
}
