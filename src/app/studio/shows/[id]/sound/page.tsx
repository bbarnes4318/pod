import Link from "next/link";
import { fetchPodcastSoundData } from "@/app/app/podcasts/[id]/sound/actions";
import SoundBranding from "@/app/app/podcasts/[id]/sound/SoundBranding";

export const dynamic = "force-dynamic";

export default async function StudioPodcastSoundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await fetchPodcastSoundData(id);

  return (
    <div className="fadeUp">
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: "1.25rem" }}>
        <div>
          <div style={{ color: "var(--accent)", fontSize: ".7rem", fontWeight: 900, letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 5 }}>
            Show Studio
          </div>
          <h1 className="pageTitle">Sound &amp; branding{data.podcastName ? ` — ${data.podcastName}` : ""}</h1>
          <p className="pageSub" style={{ marginBottom: 0 }}>
            Define the show audio identity, music pools, transitions, reactions, and loudness settings.
          </p>
        </div>
        <Link href={`/studio/shows/${id}`} className="btnGhost">← Back to show</Link>
      </header>

      <section className="studioCard" style={{ padding: "1.15rem" }}>
        {data.success ? <SoundBranding podcastId={id} data={data} /> : <p role="alert" data-testid="sound-error">{data.error}</p>}
      </section>
    </div>
  );
}
