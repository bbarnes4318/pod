// Pure outcome guard for scene-mode TTS.
//
// A scene run is publishable only when every planned scene has one selected,
// ready performance. Scene QA retries happen inside the active TTS stage so a
// recoverable candidate rejection never appears to the customer as a terminal
// BullMQ failure. Ready scene fingerprints are reused and only failed scenes are
// regenerated on the next internal attempt.

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

export const DEFAULT_SCENE_QA_ATTEMPTS = 3;
export const MAX_SCENE_QA_ATTEMPTS = 5;

/**
 * Resolve the bounded number of scene-QA attempts. The default is deliberately
 * small: each additional attempt calls the paid voice provider, while ready
 * scenes are reused and therefore are not regenerated or rebilled.
 */
export function readSceneQaAttemptLimit(raw = process.env.TTS_SCENE_QA_ATTEMPTS): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SCENE_QA_ATTEMPTS;
  return Math.max(1, Math.min(MAX_SCENE_QA_ATTEMPTS, parsed));
}

export function sceneGenerationIsComplete(summary: SceneGenerationOutcome): boolean {
  return summary.failedScenes <= 0;
}

export class PartialSceneGenerationError extends Error {
  readonly failedSceneIndexes: number[];
  readonly attemptsMade: number;

  constructor(message: string, failedSceneIndexes: number[], attemptsMade: number) {
    super(message);
    this.name = "PartialSceneGenerationError";
    this.failedSceneIndexes = failedSceneIndexes;
    this.attemptsMade = attemptsMade;
  }
}

/** Refuse to advance to mixing unless every planned scene has ready audio. */
export function assertSceneGenerationComplete(
  summary: SceneGenerationOutcome,
  attemptsMade = 1
): void {
  if (sceneGenerationIsComplete(summary)) return;

  const failed = summary.scenes.filter((scene) => scene.status !== "ready");
  const failedSceneIndexes = failed.map((scene) => scene.sceneIndex);
  const detail = failed
    .map((scene) => {
      const [first, last] = scene.lineRange;
      return `scene ${scene.sceneIndex} (lines ${first}-${last})`;
    })
    .join("; ");
  const sceneWord = summary.failedScenes === 1 ? "scene" : "scenes";
  const savedWord = summary.readyScenes === 1 ? "scene is" : "scenes are";

  throw new PartialSceneGenerationError(
    `Voice quality could not clear ${summary.failedScenes} of ${summary.sceneCount} ${sceneWord} after ${attemptsMade} automatic attempt(s): ${detail}. ` +
      `${summary.readyScenes} completed ${savedWord} saved. Try the Voices step again; only the failed scene${summary.failedScenes === 1 ? "" : "s"} will be regenerated. ` +
      `Final mixing remains paused until every scene passes.`,
    failedSceneIndexes,
    attemptsMade
  );
}
