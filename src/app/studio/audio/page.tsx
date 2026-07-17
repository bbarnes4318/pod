import { fetchMyAudioLibrary } from "./actions";
import AudioLibrary from "./AudioLibrary";

export const dynamic = "force-dynamic";

// My Audio Library (Prompt 6): the owner-facing view of their private sound
// assets + the shared system library. Auth comes from the studio layout
// (NextAuth); the actions re-verify the session on every call.
export default async function AudioLibraryPage() {
  const data = await fetchMyAudioLibrary();
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "1.5rem 1rem" }}>
      <h1>My Audio Library</h1>
      <p style={{ opacity: 0.8 }}>
        Intros, outros, beds, stingers, and reaction SFX for your shows. Uploads are validated
        server-side (real audio only), content-hashed, and private to your account.
      </p>
      {data.success ? (
        <AudioLibrary
          initialAssets={data.assets ?? []}
          podcasts={data.podcasts ?? []}
          usage={data.usage ?? {}}
        />
      ) : (
        <p role="alert" data-testid="library-error">{data.error}</p>
      )}
    </main>
  );
}
