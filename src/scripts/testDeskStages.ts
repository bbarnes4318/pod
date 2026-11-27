// The Editorial desk counts topics per stage in the database (STAGE_WHERE) and
// labels each row in code (stageOf). If the two disagree, a count says 7 and
// the list shows 6. This checks every combination of status and dossier state
// against a small evaluator for exactly the filter shapes STAGE_WHERE uses.
import assert from "node:assert";
import { STAGE_WHERE, stageOf, type Stage } from "../app/studio/desk/stages";

type Row = { editorialStatus: string; dossier: { status: string } | null };

function matches(row: Row, where: any): boolean {
  if (where.OR) return where.OR.some((w: any) => matches(row, w));
  for (const [key, cond] of Object.entries<any>(where)) {
    if (key === "editorialStatus") {
      if (row.editorialStatus !== cond) return false;
    } else if (key === "dossier") {
      if (cond.is === null) {
        if (row.dossier !== null) return false;
      } else {
        // Prisma: a relation filter with a condition never matches a missing relation.
        if (!row.dossier) return false;
        const want = cond.is.status;
        const ok = typeof want === "string" ? row.dossier.status === want : row.dossier.status !== want.not;
        if (!ok) return false;
      }
    } else throw new Error(`evaluator does not know "${key}"`);
  }
  return true;
}

let n = 0;
for (const editorialStatus of ["CANDIDATE", "HELD", "APPROVED"]) {
  for (const dossier of [null, { status: "READY" }, { status: "RESEARCHING" }, { status: "FAILED" }, { status: "HELD" }]) {
    const row = { editorialStatus, dossier };
    const hit = (Object.keys(STAGE_WHERE) as Stage[]).filter((s) => matches(row, STAGE_WHERE[s]));
    assert.deepEqual(hit, [stageOf(row)], `${editorialStatus} + ${dossier?.status ?? "no dossier"}: filter says ${hit}, row says ${stageOf(row)}`);
    n++;
  }
}
console.log(`ok  desk stages: database filter and row label agree on ${n} combinations`);
