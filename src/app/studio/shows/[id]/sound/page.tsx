import Link from "next/link";
import StudioPageHeader from "../../../StudioPageHeader";
import { fetchPodcastSoundData } from "@/app/app/podcasts/[id]/sound/actions";
import SoundBranding from "@/app/app/podcasts/[id]/sound/SoundBranding";

export const dynamic = "force-dynamic";

export default async function StudioPodcastSoundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await fetchPodcastSoundData(id);

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Sound and branding"
        subtitle="Audio identity, music pools, transitions, reactions and loudness."
        breadcrumb={[
          { label: "Shows", href: "/studio/shows" },
          ...(data.podcastName ? [{ label: data.podcastName, href: `/studio/shows/${id}` }] : []),
        ]}
      />

      <section className="studioCard">
        {data.success ? <SoundBranding podcastId={id} data={data} /> : <p role="alert" data-testid="sound-error">{data.error}</p>}
      </section>
    </div>
  );
}
