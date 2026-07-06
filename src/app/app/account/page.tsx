import { requireUserPage } from "@/lib/currentUser";
import { logoutAction } from "@/lib/authActions";

export const dynamic = "force-dynamic";

function initials(name: string | null, email: string | null): string {
  const base = (name || email || "?").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

export default async function AccountPage() {
  const user = await requireUserPage("/app/account");

  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle">Account</h1>
      </div>
      <div className="uContent">
        <div className="uAccountPage">
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.5rem" }}>
            {user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.image} alt="" className="uAvatarLg" style={{ objectFit: "cover" }} />
            ) : (
              <div className="uAvatarLg">{initials(user.name, user.email)}</div>
            )}
            <div>
              <div style={{ fontSize: "1.15rem", fontWeight: 800 }}>{user.name || "Your account"}</div>
              <div style={{ color: "var(--u-ink-2)", fontSize: "0.9rem" }}>{user.email}</div>
            </div>
          </div>

          <div style={{ marginTop: "1.5rem", background: "var(--u-surface)", border: "1px solid var(--u-hairline)", borderRadius: "var(--u-radius-lg)", padding: "0.4rem 1.4rem" }}>
            <div className="uAccountRow">
              <span className="uAccountLabel">Name</span>
              <span className="uAccountValue">{user.name || "—"}</span>
            </div>
            <div className="uAccountRow">
              <span className="uAccountLabel">Email</span>
              <span className="uAccountValue">{user.email}</span>
            </div>
            <div className="uAccountRow">
              <span className="uAccountLabel">Role</span>
              <span className="uAccountValue">{user.role}</span>
            </div>
          </div>

          <form action={logoutAction} style={{ marginTop: "1.5rem" }}>
            <button type="submit" className="uGoogleBtn" style={{ maxWidth: 200 }}>Sign out</button>
          </form>
        </div>
      </div>
    </>
  );
}
