import React from "react";
import SoundDesignConsole from "./SoundDesignConsole";
import { fetchSoundDesignData } from "./actions";

export const dynamic = "force-dynamic";

export default async function SoundDesignPage() {
  const data = await fetchSoundDesignData();

  return (
    <SoundDesignConsole
      initialAssets={data.success && data.assets ? data.assets : []}
      initialConfig={data.success && data.config ? data.config : null}
      loadError={data.success ? null : data.error || "Failed to load sound design data."}
    />
  );
}
