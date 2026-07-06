import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/currentUser";
import { googleAuthConfigured } from "@/lib/auth";
import SignupForm from "./SignupForm";

export const dynamic = "force-dynamic";

function normalizeCallback(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw && raw.startsWith("/app") ? raw : "/app";
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
    <div className="uAuthWrap">
      <div className="uAuthCard">
        <Link href="/app" className="uAuthMark" aria-label="Take Machine home">T</Link>
        <h1 className="uAuthTitle">Create your account</h1>
        <p className="uAuthSub">Own the podcasts and episodes you make on Take Machine.</p>
        <SignupForm callbackUrl={target} googleEnabled={googleAuthConfigured} />
      </div>
    </div>
  );
}
