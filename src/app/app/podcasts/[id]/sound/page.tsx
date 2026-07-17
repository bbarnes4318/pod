import { fetchPodcastSoundData } from "./actions";
import SoundBranding from "./SoundBranding";

export const dynamic = "force-dynamic";

// Podcast Sound & Branding (Prompt 6): this show's sound profile — mode,
// intro/outro/bed, stinger + reaction pools, gains/fades, cooldown scope.
export default async function PodcastSoundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await fetchPodcastSoundData(id);
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "1.5rem 1rem" }}>
      <h1>Sound &amp; Branding{data.podcastName ? ` — ${data.podcastName}` : ""}</h1>
      {data.success ? (
        <SoundBranding podcastId={id} data={data} />
      ) : (
        <p role="alert" data-testid="sound-error">{data.error}</p>
      )}
    </main>
  );
}
