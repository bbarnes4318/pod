import Link from "next/link";
import { fetchPodcastSoundData } from "./actions";
import SoundBranding from "./SoundBranding";

export const dynamic = "force-dynamic";

// Podcast Sound & Branding (Prompt 6): this show's sound profile — mode,
// intro/outro/bed, stinger + reaction pools, gains/fades, cooldown scope.
export default async function PodcastSoundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await fetchPodcastSoundData(id);
  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle">Sound &amp; Branding{data.podcastName ? ` — ${data.podcastName}` : ""}</h1>
        <Link href={`/app/podcasts/${id}`} style={{ color: "var(--u-brand)", fontWeight: 650, fontSize: "0.9rem" }}>
          ← Back to podcast
        </Link>
      </div>
      <div className="uContent" style={{ maxWidth: 960 }}>
        {data.success ? (
          <SoundBranding podcastId={id} data={data} />
        ) : (
          <p role="alert" data-testid="sound-error">{data.error}</p>
        )}
      </div>
    </>
  );
}
