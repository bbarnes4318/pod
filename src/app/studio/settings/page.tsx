import { currentUser } from "@/lib/currentUser";
import { AppPage, PageHeader, ButtonLink, Card, SectionHeader, StatusBadge } from "@/components/studio";

export const metadata = { title: "Settings — Take Machine Studio" };

const CUSTOMER_SECTIONS = [
  { id: "hosts", title: "Hosts and casting", description: "Create the personalities assigned to your shows and episodes.", href: "/studio/hosts", action: "Manage hosts" },
  { id: "voices", title: "Voices", description: "Design, clone, assign, and preview the voice attached to each host.", href: "/studio/hosts", action: "Open voice controls" },
  { id: "sound", title: "Sound", description: "Manage a show’s music, transitions, beds, and sonic identity from its headquarters.", href: "/studio/shows", action: "Choose a show" },
  { id: "sources", title: "Data sources", description: "Sports research and topic ingestion are managed by the production pipeline.", href: "/studio/takes", action: "Review incoming takes" },
  { id: "publishing", title: "Publishing", description: "Review packaging status and release completed episodes.", href: "/studio/publish", action: "Open publishing" },
  { id: "feeds", title: "RSS and feeds", description: "Verify the public feed and the episodes currently available to listeners.", href: "/rss", action: "Open public feed" },
  { id: "workspace", title: "Account and workspace", description: "Review your workspace access, active plan, and usage.", href: "/studio/plan", action: "View plan and usage" },
  { id: "billing", title: "Billing", description: "Plan changes and production allowances are managed from the Plan page.", href: "/studio/plan", action: "Manage plan" },
];

export default async function StudioSettingsPage({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const user = await currentUser();
  const { section } = await searchParams;
  const active = CUSTOMER_SECTIONS.find(item => item.id === section) || CUSTOMER_SECTIONS[0];
  const isAdmin = user?.role === "ADMIN";

  return <AppPage>
    <PageHeader title="Settings" description="Customer workspace preferences stay separate from technical pipeline operations." />
    <div className="settingsProductionLayout">
      <nav className="settingsProductionNav" aria-label="Settings sections">{CUSTOMER_SECTIONS.map(item => <ButtonLink key={item.id} href={`/studio/settings?section=${item.id}`} variant={active.id === item.id ? "secondary" : "ghost"}>{item.title}</ButtonLink>)}{isAdmin && <div className="settingsAdminGroup"><span>Admin</span><ButtonLink href="/admin/job-logs" variant="ghost">Job logs</ButtonLink><ButtonLink href="/admin/configuration" variant="ghost">Pipeline configuration</ButtonLink><ButtonLink href="/admin" variant="ghost">Ops Console</ButtonLink></div>}</nav>
      <Card className="settingsProductionPanel"><SectionHeader title={active.title} description={active.description} />{active.id === "sources" ? <div className="settingsStatus"><StatusBadge tone="success">Automatic</StatusBadge><p>The system’s active ingestion sources populate the Takes queue. Customer controls remain focused on selecting and producing stories rather than infrastructure.</p></div> : active.id === "feeds" ? <div className="settingsStatus"><StatusBadge tone="info">Public feed</StatusBadge><p>Open the feed to verify the current published output. Publishing controls remain on the Publishing page.</p></div> : <div className="settingsStatus"><p>This setting is managed in its dedicated Studio workspace so changes, loading states, validation, and success messages stay next to the affected content.</p></div>}<ButtonLink href={active.href} variant="primary">{active.action}</ButtonLink></Card>
    </div>
  </AppPage>;
}
