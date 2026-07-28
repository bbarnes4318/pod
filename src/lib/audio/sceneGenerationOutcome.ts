// Pure outcome guard for scene-mode TTS.
//
// A scene run is publishable only when every planned scene has one selected,
// ready performance. The worker's BullMQ job already has a bounded retry policy;
// throwing here lets that SAME job retry while ttsSceneService reuses every ready
// scene and regenerates only the missing ones. It also prevents a partial TTS run
// from chaining another brand-new TTS job forever while the episode remains
// `fact_checked`.

export interface SceneOutcomeItem {
  sceneIndex: number;
  lineRange: [number, number];
  status: string;
  errorCategory?: string;
}

export interface SceneGenerationOutcome {
  sceneCount: number;
  readyScenes: number;
  failedScenes: number;
  scenes: SceneOutcomeItem[];
}

export class PartialSceneGenerationError extends Error {
  readonly failedSceneIndexes: number[];

  constructor(message: string, failedSceneIndexes: number[]) {
    super(message);
    this.name = "PartialSceneGenerationError";
    this.failedSceneIndexes = failedSceneIndexes;
  }
}

/**
 * Refuse to treat a partial scene render as a completed TTS stage.
 *
 * The caller should let the current BullMQ job fail. Its configured attempts
 * provide the retry bound; because ready scene rows are fingerprint-reused,
 * another attempt regenerates only the failed scenes rather than rebilling the
 * entire episode.
 */
export function assertSceneGenerationComplete(summary: SceneGenerationOutcome): void {
  if (summary.failedScenes <= 0) return;

  const failed = summary.scenes.filter((scene) => scene.status !== "ready");
  const failedSceneIndexes = failed.map((scene) => scene.sceneIndex);
  const detail = failed
    .map((scene) => {
      const [first, last] = scene.lineRange;
      return `scene ${scene.sceneIndex} (lines ${first}-${last}, ${scene.errorCategory || "unknown failure"})`;
    })
    .join("; ");

  throw new PartialSceneGenerationError(
    `Scene performance QA rejected ${summary.failedScenes} of ${summary.sceneCount} scene(s): ${detail}. ` +
      `${summary.readyScenes} ready scene(s) are preserved; the bounded job retry will regenerate only the failed scenes. ` +
      `Final mixing is blocked until every scene passes.`,
    failedSceneIndexes
  );
}
