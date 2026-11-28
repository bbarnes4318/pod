// The approved AI Executive Producer brief, read-only, on the episode's
// Rundown stage: what the creator asked for and what the script was told to
// build. Server component; reads Episode.editorialBrief as stored.
import { db } from "@/lib/db";
import { readBrief, SECTION_LABEL, type BriefSection } from "@/lib/studio/executiveBrief";

export async function BriefSummary({ value }: { value: unknown }) {
  const brief = readBrief(value);
  if (!brief) return null;
  const on = (s: BriefSection) => !brief.rejected.includes(s);
  const hosts = brief.hostAssignments.length
    ? await db.aiHost.findMany({ where: { id: { in: brief.hostAssignments.map((h) => h.hostId) } }, select: { id: true, name: true } })
    : [];
  const name = (id: string) => hosts.find((h) => h.id === id)?.name ?? "A host";
  const row = (s: BriefSection, v: string | undefined) => (on(s) && v ? <div className="epBriefRow"><dt>{SECTION_LABEL[s]}</dt><dd>{v}</dd></div> : null);
  return (
    <section className="epBrief" aria-label="Production brief" data-testid="episode-brief">
      <div className="epBriefHead">
        <h3 className="m-0">Production brief</h3>
        <span className={`statusPill statusPill--${brief.source === "model" ? "ok" : "warn"}`}>
          {brief.source === "model" ? `Drafted by an AI model${brief.model ? ` (${brief.model})` : ""}, approved by you` : "Built from research on file, no AI model"}
        </span>
      </div>
      {brief.objective && <p className="epBriefGoal">“{brief.objective}”</p>}
      <dl className="epBriefList">
        {row("thesis", brief.thesis.value)}
        {row("hook", brief.hook.value)}
        {row("angle", brief.angle.value)}
        {on("segments") && (
          <div className="epBriefRow"><dt>{SECTION_LABEL.segments}</dt><dd><ol>{brief.segments.map((s, i) => <li key={i}><strong>{s.title}</strong> — {s.goal}</li>)}</ol></dd></div>
        )}
        {on("hostAssignments") && brief.hostAssignments.length > 0 && (
          <div className="epBriefRow"><dt>{SECTION_LABEL.hostAssignments}</dt><dd><ul>{brief.hostAssignments.map((h) => <li key={h.hostId}><strong>{name(h.hostId)}</strong>: {h.perspective}</li>)}</ul></dd></div>
        )}
        {on("takeaways") && brief.takeaways.length > 0 && (
          <div className="epBriefRow"><dt>{SECTION_LABEL.takeaways}</dt><dd><ul>{brief.takeaways.map((t, i) => <li key={i}>{t}</li>)}</ul></dd></div>
        )}
        {on("researchNeeds") && brief.researchNeeds.length > 0 && (
          <div className="epBriefRow"><dt>{SECTION_LABEL.researchNeeds}</dt><dd><ul>{brief.researchNeeds.map((t, i) => <li key={i}>{t}</li>)}</ul></dd></div>
        )}
      </dl>
      <p className="epNote">The script was written to this brief. It sets the argument and structure; facts come only from the research.{brief.rejected.length ? ` ${brief.rejected.length} section${brief.rejected.length === 1 ? " was" : "s were"} dropped and not used.` : ""}</p>
    </section>
  );
}
