import AuthFrame from "../AuthFrame";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/currentUser";
import { googleAuthConfigured } from "@/lib/auth";
import { safeCallbackUrl } from "@/lib/authCallback";
import SignupForm from "./SignupForm";

export const dynamic = "force-dynamic";

function normalizeCallback(v: string | string[] | undefined): string {
  return safeCallbackUrl(v);
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;
  const target = normalizeCallback(callbackUrl);

  if (await currentUser()) redirect(target);

  return (
    <AuthFrame title="Create your account" subtitle="Set up your studio in a minute.">
      <SignupForm callbackUrl={target} googleEnabled={googleAuthConfigured} />
    </AuthFrame>
  );
}
