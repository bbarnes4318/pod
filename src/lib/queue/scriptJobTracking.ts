export const SCRIPT_JOB_TYPE = "generate:script";

/**
 * One pending BullMQ script job per episode. Completed jobs are removed by the
 * queue; failed jobs are explicitly removed before a later retry is enqueued.
 */
export function scriptGenerationJobId(episodeId: string): string {
  return `generate-script-${episodeId}`;
}

/** BullMQ states that mean the request already exists and must not be duplicated. */
export function isPendingScriptJobState(state: string): boolean {
  return ["waiting", "delayed", "prioritized", "active", "waiting-children"].includes(state);
}

/** Only jobs that have not started may safely accept newer producer options. */
export function canUpdateQueuedScriptJob(state: string): boolean {
  return ["waiting", "delayed", "prioritized"].includes(state);
}

export interface ScriptJobLogLike {
  id: string;
  jobType: string;
  status: string;
  input: unknown;
  createdAt: Date | string;
}

export function scriptLogEpisodeId(log: Pick<ScriptJobLogLike, "input">): string | null {
  if (!log.input || typeof log.input !== "object" || Array.isArray(log.input)) return null;
  const episodeId = (log.input as Record<string, unknown>).episodeId;
  return typeof episodeId === "string" && episodeId.length > 0 ? episodeId : null;
}

/**
 * Enqueue-time rows make waiting jobs visible immediately. The legacy worker
 * still writes a new running/completed row when it starts. Hide the older
 * queued row once that later execution row exists, so the operator sees one
 * truthful lifecycle instead of a permanently queued duplicate.
 */
export function queuedScriptLogIsSuperseded(
  log: ScriptJobLogLike,
  allLogs: ScriptJobLogLike[]
): boolean {
  if (log.jobType !== SCRIPT_JOB_TYPE || log.status !== "queued") return false;
  const episodeId = scriptLogEpisodeId(log);
  if (!episodeId) return false;
  const queuedAt = new Date(log.createdAt).getTime();

  return allLogs.some((candidate) => {
    if (candidate.id === log.id) return false;
    if (candidate.jobType !== SCRIPT_JOB_TYPE || candidate.status === "queued") return false;
    if (scriptLogEpisodeId(candidate) !== episodeId) return false;
    return new Date(candidate.createdAt).getTime() >= queuedAt;
  });
}
