import Link from "next/link";
import { currentUser } from "@/lib/currentUser";
import { logoutAction } from "@/lib/authActions";

function initials(name: string | null, email: string | null): string {
  const base = (name || email || "?").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

/** Server-rendered signed-in indicator for the /app sidebar: avatar + name
 *  linking to the account page, plus a sign-out button. Shows a Sign in
 *  button when logged out. */
export default async function SidebarAccount() {
  const user = await currentUser();

  if (!user) {
    return (
      <div className="uAccount">
        <Link href="/app/login" className="uSignInBtn">
          <span>Sign in</span>
        </Link>
      </div>
    );
  }

  const label = (user.name || user.email || "Account").split(/\s+/)[0];

  return (
    <div className="uAccount">
      <Link href="/app/account" className="uAccountChip">
        <span className="uAvatar" aria-hidden="true">{initials(user.name, user.email)}</span>
        <span className="uAccountName">{label}</span>
      </Link>
      <form action={logoutAction} style={{ width: "100%" }}>
        <button type="submit" className="uLogout">Sign out</button>
      </form>
    </div>
  );
}
