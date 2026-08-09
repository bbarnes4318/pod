import { fetchMyAudioLibrary } from "./actions";
import StudioPageHeader from "../StudioPageHeader";
import AudioLibrary from "./AudioLibrary";

export const dynamic = "force-dynamic";

// My Audio Library (Prompt 6): the owner-facing view of their private sound
// assets + the shared system library. Auth comes from the studio layout
// (NextAuth); the actions re-verify the session on every call.
export default async function AudioLibraryPage() {
  const data = await fetchMyAudioLibrary();
  return (
    <div className="fadeUp audioLibraryPage">
      <StudioPageHeader
        title="Audio"
        subtitle="Intros, outros, beds, stingers and reaction SFX. Private to your account."
      />
      {data.success ? (
        <AudioLibrary
          initialAssets={data.assets ?? []}
          podcasts={data.podcasts ?? []}
          usage={data.usage ?? {}}
        />
      ) : (
        <p role="alert" data-testid="library-error">{data.error}</p>
      )}
    </div>
  );
}
