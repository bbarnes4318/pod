// Where a business research topic sits in the pipeline, stated twice on
// purpose: once for a row in hand (`stageOf`) and once as a database filter
// (`STAGE_WHERE`), so the desk's counts and list are exact however many topics
// exist. They used to be computed in memory over the first 120 rows.
// `src/scripts/testDeskStages.ts` proves the two agree for every combination.

export type Stage = "discover" | "investigate" | "approve" | "produce";

export function stageOf(o: { editorialStatus: string; dossier: { status: string } | null }): Stage {
  if (o.editorialStatus === "APPROVED") return "produce";
  if (o.editorialStatus === "HELD") return "investigate";
  if (!o.dossier) return "discover";
  if (o.dossier.status === "READY") return "approve";
  return "investigate";
}

/** Applies to OPEN topics only (CANDIDATE, HELD, APPROVED), which is all the desk loads. */
export const STAGE_WHERE: Record<Stage, Record<string, unknown>> = {
  produce: { editorialStatus: "APPROVED" },
  discover: { editorialStatus: "CANDIDATE", dossier: { is: null } },
  approve: { editorialStatus: "CANDIDATE", dossier: { is: { status: "READY" } } },
  investigate: { OR: [{ editorialStatus: "HELD" }, { editorialStatus: "CANDIDATE", dossier: { is: { status: { not: "READY" } } } }] },
};
