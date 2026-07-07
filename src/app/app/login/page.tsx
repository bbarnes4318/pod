import Link from "next/link";
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
    <div className="uAuthWrap">
      <div className="uAuthCard">
        <Link href="/app" className="uAuthMark" aria-label="Take Machine home">T</Link>
        <h1 className="uAuthTitle">Welcome back</h1>
        <p className="uAuthSub">Sign in to build and manage your podcasts.</p>
        <LoginForm callbackUrl={target} googleEnabled={googleAuthConfigured} />
      </div>
    </div>
  );
}
