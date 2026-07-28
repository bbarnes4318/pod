// Deterministic identity for one requested script version.
//
// A Studio click must be traceable before a worker picks the job up. BullMQ's
// job id and the submission JobLog id are therefore derived from the episode
// plus the next script version. Repeated clicks while that version is waiting
// or active resolve to the same job instead of creating an invisible backlog.

export interface ScriptQueueIdentity {
  jobId: string;
  submissionLogId: string;
  targetVersion: number;
}

export function scriptQueueIdentity(episodeId: string, targetVersion: number): ScriptQueueIdentity {
  const version = Math.max(1, Math.floor(targetVersion));
  return {
    jobId: `script-${episodeId}-v${version}`,
    submissionLogId: `script-submit-${episodeId}-v${version}`,
    targetVersion: version,
  };
}

/** Jobs in these states already represent the requested generation. */
export function scriptJobIsInFlight(state: string): boolean {
  return [
    "waiting",
    "active",
    "delayed",
    "prioritized",
    "waiting-children",
    "paused",
  ].includes(state);
}
